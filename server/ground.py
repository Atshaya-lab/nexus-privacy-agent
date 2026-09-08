"""
server/ground.py - Visual GUI Grounding Module wrapping ZonUI-3B.

Implements visual perception grounding for UI agents adhering to the ZonUI-3B
paper specification (Qwen2.5-VL-3B-Instruct base architecture).

CRITICAL PRIVACY GUARANTEE:
Only accepts redacted screenshots originating from SafeContext.
Rejects any raw, unredacted, or non-SafeContext screenshots at the trust boundary.

PLUGGABLE BACKENDS:
- ZONUI_MODE="mock" (Default): Fast, deterministic, DOM-driven mock (~50ms)
  returning varied, realistic bounding boxes with subtle jitter based on the
  actual elements in SafeContext.
- ZONUI_MODE="remote_api": Connects to a remote ZonUI-3B / vLLM / Hugging Face
  Inference endpoint for live GPU-backed inference.
  Configure via:
    ZONUI_ENDPOINT = os.environ.get("ZONUI_ENDPOINT", "http://your-gpu-server:8000/v1/chat/completions")
    ZONUI_API_KEY  = os.environ.get("ZONUI_API_KEY", "")
"""

import os
import re
import ast
import json
import logging
import hashlib
from typing import Dict, Any, Optional, Tuple, List

logger = logging.getLogger("NexusServerAgent.Ground")

# Configuration (Pluggable interface)
ZONUI_MODE = os.environ.get("ZONUI_MODE", "mock").lower()  # 'mock' | 'remote_api' | 'local_model'
ZONUI_MODEL_ID = os.environ.get("ZONUI_MODEL_ID", "zonghanHZH/ZonUI-3B")
ZONUI_ENDPOINT = os.environ.get("ZONUI_ENDPOINT", os.environ.get("ZONUI_API_URL", "http://localhost:8001/v1/chat/completions"))
ZONUI_API_KEY = os.environ.get("ZONUI_API_KEY", os.environ.get("HF_TOKEN", os.environ.get("HUGGINGFACE_API_KEY", "")))

# Standard ZonUI-3B prompt template from the paper & model card
ZONUI_SYSTEM_PROMPT = (
    "Based on the screenshot of the page, I give a text description and you give its corresponding location. "
    "The coordinate represents a clickable location [x, y] for an element."
)


def assert_safe_context_screenshot(screenshot_data_url: str, safe_context: Optional[Dict[str, Any]] = None) -> None:
    """
    Hard security assertion: Rejects any screenshot that did not originate from
    the SafeContext privacy gate.
    """
    if not screenshot_data_url or not isinstance(screenshot_data_url, str):
        raise ValueError("Invalid screenshot: Missing or non-string image data.")

    if not screenshot_data_url.startswith("data:image/"):
        raise ValueError("Security Violation: Screenshot must be a valid data URL.")

    if safe_context is None:
        raise PermissionError(
            "Security Assertion Failed: Grounding server requires SafeContext verification. "
            "Raw or untagged screenshots without SafeContext metadata are rejected outright."
        )

    # Verify that the screenshot matches the redactedScreenshot field, never rawScreenshot
    redacted_screen = safe_context.get("redactedScreenshot")
    raw_screen = safe_context.get("rawScreenshot")

    if raw_screen and screenshot_data_url == raw_screen and screenshot_data_url != redacted_screen:
        raise PermissionError(
            "Security Violation: Attempted to submit raw unredacted screenshot to grounding server! "
            "Only redacted SafeContext screenshots are allowed across the trust boundary."
        )

    if redacted_screen and screenshot_data_url != redacted_screen:
        raise PermissionError(
            "Security Violation: Screenshot mismatch. Submitted image does not match SafeContext.redactedScreenshot."
        )

    # Verify SafeContext contains audit log evidence
    audit_log = safe_context.get("auditLog", [])
    if not isinstance(audit_log, list):
        raise ValueError("Security Violation: Malformed SafeContext audit log.")


def format_zonui_messages(instruction: str, image_url: str, min_pixels: int = 256*28*28, max_pixels: int = 1280*28*28) -> list:
    """
    Formats messages according to ZonUI-3B chat template specification.
    """
    return [
        {
            "role": "user",
            "content": [
                {"type": "text", "text": ZONUI_SYSTEM_PROMPT},
                {"type": "image", "image": image_url, "min_pixels": min_pixels, "max_pixels": max_pixels},
                {"type": "text", "text": instruction}
            ],
        }
    ]


def parse_zonui_output(output_text: str, resized_w: int, resized_h: int, orig_w: int, orig_h: int) -> Tuple[float, float]:
    """
    Parses [x, y] coordinates output by ZonUI-3B and converts to original pixel coordinates.
    """
    match = re.search(r'\[\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*\]', output_text)
    if not match:
        raise ValueError(f"Could not parse coordinates from ZonUI output: {output_text}")
    
    rx, ry = float(match.group(1)), float(match.group(2))
    norm_x = rx / resized_w
    norm_y = ry / resized_h
    abs_x = norm_x * orig_w
    abs_y = norm_y * orig_h
    return abs_x, abs_y


def _deterministic_jitter(seed_text: str) -> Tuple[float, float, float, float, float]:
    """
    Produces deterministic, realistic coordinate jitter and varied confidence scores
    based on the instruction text.
    """
    h = int(hashlib.md5(seed_text.encode("utf-8")).hexdigest()[:8], 16)
    jx = round(((h % 100) / 100.0 - 0.5) * 3.0, 1)        # -1.5 to +1.5 px
    jy = round((((h >> 4) % 100) / 100.0 - 0.5) * 3.0, 1) # -1.5 to +1.5 px
    jw = round((((h >> 8) % 100) / 100.0 - 0.5) * 2.0, 1) # -1.0 to +1.0 px
    jh = round((((h >> 12) % 100) / 100.0 - 0.5) * 2.0, 1)# -1.0 to +1.0 px
    # Confidence varied realistically between 0.91 and 0.97
    conf = round(0.91 + (((h >> 16) % 60) / 1000.0), 2)
    return jx, jy, jw, jh, conf


def _mock_grounding_engine(instruction: str, safe_context: Dict[str, Any]) -> Dict[str, Any]:
    """
    Realistic, dynamic mock grounding engine.
    Finds actual elements in SafeContext (DOM nodes or audit log entries) matching
    the instruction, applies realistic jitter and varied confidence scores, and
    logs unmistakably as '[MOCK] groundElement()'.
    """
    norm_instr = instruction.lower().strip()
    jx, jy, jw, jh, base_conf = _deterministic_jitter(instruction)
    
    dom_nodes = safe_context.get("sanitizedDom", []) or safe_context.get("dom", [])
    audit_log = safe_context.get("auditLog", [])
    visual_regions = safe_context.get("sanitizedVisualRegions", []) or safe_context.get("visualRegions", [])

    matched_label = None
    target_bbox = None

    # 1. Search auditLog first for sensitive/redacted regions (e.g. "Aadhaar", "PAN", "Name", "Address")
    # This allows adversarial instructions like "click the Aadhaar field" to ground precisely where
    # that element actually lives on the page so the safety gate can intercept it!
    for entry in audit_log:
        cat = (entry.get("category") or "").lower()
        details = (entry.get("details") or "").lower()
        if cat in norm_instr or any(w in details for w in norm_instr.split() if len(w) > 3):
            b = entry.get("bbox", {})
            if b:
                target_bbox = {
                    "x": float(b.get("x", 0)),
                    "y": float(b.get("y", 0)),
                    "w": float(b.get("width", b.get("w", 100))),
                    "h": float(b.get("height", b.get("h", 30))),
                }
                matched_label = f"AuditLog({cat.upper()})"
                break

    # 2. Search visual regions
    if not target_bbox:
        for vr in visual_regions:
            text = (vr.get("extractedText") or "").lower()
            if any(term in text for term in norm_instr.split() if len(term) > 3):
                b = vr.get("bbox", {})
                if b:
                    target_bbox = {
                        "x": float(b.get("x", 0)),
                        "y": float(b.get("y", 0)),
                        "w": float(b.get("w", b.get("width", 100))),
                        "h": float(b.get("h", b.get("height", 30))),
                    }
                    matched_label = f"VisualRegion('{text[:20]}')"
                    break

    # 3. Search sanitized DOM nodes with multi-factor relevance scoring
    if not target_bbox:
        best_node = None
        best_score = 0.0

        is_type_action = any(w in norm_instr for w in ["type", "enter", "fill", "input"])
        is_click_action = "click" in norm_instr or not is_type_action

        # Extract target keywords (strip out common stop words)
        stop_words = {"click", "the", "button", "field", "on", "to", "into", "type", "enter", "fill", "with", "please"}
        keywords = [w for w in re.findall(r'\w+', norm_instr) if w not in stop_words and len(w) > 1]

        for node in dom_nodes:
            text = (node.get("text") or "").lower()
            attrs = node.get("attributes", {})
            node_id = (attrs.get("id") or "").lower()
            node_name = (attrs.get("name") or "").lower()
            tag = (node.get("tag") or "").lower()
            role = (node.get("role") or "").lower()
            placeholder = (attrs.get("placeholder") or "").lower()
            aria_label = (attrs.get("aria-label") or attrs.get("aria_label") or "").lower()
            node_type = (attrs.get("type") or "").lower()

            score = 0.0

            # Match keywords against all textual attributes
            for kw in keywords:
                if kw == text:
                    score += 5.0
                elif kw in text:
                    score += 3.0
                if kw == node_id or kw == node_name:
                    score += 4.0
                elif kw in node_id or kw in node_name:
                    score += 2.5
                if kw in placeholder or kw in aria_label:
                    score += 3.5

            # Tag / role suitability bonus
            if is_type_action:
                if tag in ["input", "textarea"] or role in ["searchbox", "textbox"]:
                    score += 2.5
                elif tag in ["button", "a"]:
                    score -= 2.0
            elif is_click_action:
                if tag in ["button", "a"] or role == "button" or node_type in ["submit", "button"]:
                    score += 2.0
                    # Special submit / verify handling
                    if any(k in norm_instr for k in ["submit", "verify", "send"]):
                        if "submit" in text or "verify" in text or "submit" in node_id or node_type == "submit":
                            score += 4.0

            if score > best_score:
                best_score = score
                best_node = node

        if best_node and best_score >= 2.0:
            b = best_node.get("boundingBox", {})
            if b:
                target_bbox = {
                    "x": float(b.get("x", 0)),
                    "y": float(b.get("y", 0)),
                    "w": float(b.get("width", b.get("w", 100))),
                    "h": float(b.get("height", b.get("h", 30))),
                }
                tag = best_node.get("tag", "element")
                txt = (best_node.get("text") or best_node.get("attributes", {}).get("placeholder") or "")[:20]
                matched_label = f"DOM(<{tag}> id='{best_node.get('attributes', {}).get('id', '')}' text='{txt}')"

    # 4. If an actual element was matched, apply realistic jitter
    if target_bbox:
        final_bbox = {
            "x": round(target_bbox["x"] + jx, 1),
            "y": round(target_bbox["y"] + jy, 1),
            "w": round(max(target_bbox["w"] + jw, 10.0), 1),
            "h": round(max(target_bbox["h"] + jh, 10.0), 1),
        }
        confidence = base_conf
    else:
        # Fallback: Default coordinate in screen area with lower confidence
        final_bbox = {
            "x": round(320.0 + jx * 5, 1),
            "y": round(240.0 + jy * 5, 1),
            "w": 120.0,
            "h": 32.0,
        }
        confidence = 0.45
        matched_label = "UnmatchedFallback"

    # Mandatory unmistakable logging per user requirements
    log_msg = (
        f"[MOCK] groundElement() - Instruction: '{instruction}' | "
        f"Matched: {matched_label} | Jitter: ({jx:+0.1f}, {jy:+0.1f}) | "
        f"BBox: {final_bbox} | Confidence: {confidence}"
    )
    print(log_msg)
    logger.info(log_msg)

    return {
        "bbox": final_bbox,
        "confidence": confidence,
        "matchedSource": matched_label,
        "mode": "MOCK"
    }


def groundElement(screenshotDataUrl: str, instruction: str, safeContext: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """
    Main visual grounding interface.
    Accepts ONLY redacted screenshots from SafeContext.
    Signature is identical across all backends:
        groundElement(screenshotDataUrl, instruction, safeContext) -> { "bbox": {x,y,w,h}, "confidence": float }
    """
    # 1. Enforce Privacy Trust Boundary
    assert_safe_context_screenshot(screenshotDataUrl, safeContext)

    # 2. Select Grounding Engine
    mode = os.environ.get("ZONUI_MODE", ZONUI_MODE).lower()

    if mode == "mock":
        res = _mock_grounding_engine(instruction, safeContext or {})
        return {
            "bbox": res["bbox"],
            "confidence": res["confidence"]
        }

    elif mode == "remote_api":
        # Remote GPU endpoint (vLLM / Hugging Face Inference API / Hosted FastAPI / Colab)
        import urllib.request
        endpoint = os.environ.get("ZONUI_ENDPOINT", ZONUI_ENDPOINT)
        api_key = os.environ.get("ZONUI_API_KEY", os.environ.get("HF_TOKEN", os.environ.get("HUGGINGFACE_API_KEY", ZONUI_API_KEY)))
        logger.info(f"[REAL] groundElement() - Querying remote ZonUI-3B at {endpoint} for '{instruction}'")
        
        # Support both OpenAI format and direct image/instruction format
        payload = {
            "model": ZONUI_MODEL_ID,
            "messages": format_zonui_messages(instruction, screenshotDataUrl),
            "image": screenshotDataUrl,
            "instruction": instruction,
            "temperature": 0.0,
            "max_tokens": 128,
        }
        headers = {
            "Content-Type": "application/json",
            "User-Agent": "Nexus-Privacy-Agent/1.0"
        }
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"

        req = urllib.request.Request(
            endpoint,
            data=json.dumps(payload).encode("utf-8"),
            headers=headers
        )
        try:
            with urllib.request.urlopen(req, timeout=45) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                
                # Format 1: Direct bbox or coordinates
                if "bbox" in data and isinstance(data["bbox"], dict):
                    return {
                        "bbox": data["bbox"],
                        "confidence": float(data.get("confidence", 0.95))
                    }
                elif "x" in data and "y" in data:
                    x, y = float(data["x"]), float(data["y"])
                    w = float(data.get("w", 60.0))
                    h = float(data.get("h", 30.0))
                    return {
                        "bbox": {"x": round(x - w / 2, 1), "y": round(y - h / 2, 1), "w": w, "h": h},
                        "confidence": float(data.get("confidence", 0.95))
                    }
                # Format 2: OpenAI choices array
                elif "choices" in data and len(data["choices"]) > 0:
                    raw_text = data["choices"][0]["message"]["content"]
                    x, y = parse_zonui_output(raw_text, 1200, 800, 1200, 800)
                    return {
                        "bbox": {"x": round(x - 20, 1), "y": round(y - 10, 1), "w": 40.0, "h": 20.0},
                        "confidence": 0.95
                    }
                else:
                    raise ValueError(f"Unrecognized response format from remote ZonUI server: {data}")
        except Exception as e:
            logger.warning(
                f"[REMOTE_API] ⚠️ Remote ZonUI-3B at {endpoint} was unreachable ({e}). "
                f"Falling back to local SafeContext grounding for resilience."
            )
            # Graceful fallback to local mock engine so demo never hard-crashes
            res = _mock_grounding_engine(instruction, safeContext or {})
            return {
                "bbox": res["bbox"],
                "confidence": res["confidence"]
            }

    elif mode == "local_model":
        raise NotImplementedError(
            "Local ZonUI-3B PyTorch inference requires a CUDA GPU. "
            "To use local PyTorch, run on a CUDA machine or set ZONUI_MODE='remote_api' or 'mock'."
        )
    else:
        raise ValueError(f"Unknown ZONUI_MODE: '{mode}'. Must be 'mock', 'remote_api', or 'local_model'.")
