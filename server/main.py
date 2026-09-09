"""
server/main.py - FastAPI Service for Nexus Privacy Agent (Server Agent).

Exposes POST /agent/plan to decompose tasks, run ZonUI-3B visual grounding,
cross-verify against the DOM and audit log, and return safe action plans.
"""

import os
import sys
import time
import logging

# Ensure project root is in sys.path
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)

from typing import List, Dict, Any, Optional, Literal
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from server.ground import groundElement, ZONUI_MODE, ZONUI_ENDPOINT, set_zonui_config, get_zonui_config
from server.planner import planSteps
from server.verify import crossVerify

# Setup structured logging
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")
logger = logging.getLogger("NexusServerAgent")

app = FastAPI(
    title="Nexus Privacy Agent - Server Agent",
    description="Visual GUI Grounding & Task Planning Server powered by ZonUI-3B with Privacy Gate",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ------------------------------------------------------------------------------
# Request / Response Schemas
# ------------------------------------------------------------------------------
class ServerConfigRequest(BaseModel):
    mode: Optional[str] = None
    endpoint: Optional[str] = None
    apiKey: Optional[str] = None
    modelId: Optional[str] = None


class ActionItem(BaseModel):
    action: Literal["click", "type", "scroll", "select"] = "click"
    targetSelector: str
    value: Optional[str] = None
    groundedBbox: Dict[str, float]
    confidence: float
    reasoning: str


class BlockedActionItem(BaseModel):
    step: str
    groundedBbox: Dict[str, float]
    reason: str
    auditEntry: Optional[Dict[str, Any]] = None


class PlanRequest(BaseModel):
    task: str
    safeContext: Dict[str, Any]


class PlanResponse(BaseModel):
    done: bool
    summary: str
    groundingMode: str
    actions: List[ActionItem]
    blockedActions: List[BlockedActionItem]
    auditTrail: List[Dict[str, Any]]


# ------------------------------------------------------------------------------
# Endpoints
# ------------------------------------------------------------------------------
@app.get("/health")
def health_check():
    cfg = get_zonui_config()
    return {
        "status": "healthy",
        "service": "Nexus Server Agent",
        "groundingModel": cfg["modelId"],
        "groundingMode": cfg["mode"],
        "endpoint": cfg["endpoint"] if cfg["mode"] == "REMOTE_API" else "local",
        "privacyBoundary": "SafeContext-enforced",
    }


@app.get("/demo", response_class=HTMLResponse)
def get_demo_page():
    demo_path = os.path.join(os.path.dirname(os.path.dirname(__file__)), "test-page", "index.html")
    if os.path.exists(demo_path):
        with open(demo_path, "r", encoding="utf-8") as f:
            return f.read()
    return "<h1>Nexus Privacy Agent Demo Page</h1>"


@app.get("/fixture", response_class=HTMLResponse)
def get_fixture_page():
    fixture_path = os.path.join(os.path.dirname(os.path.dirname(__file__)), "test-fixtures", "mock-id-card.html")
    if os.path.exists(fixture_path):
        with open(fixture_path, "r", encoding="utf-8") as f:
            return f.read()
    return "<h1>Nexus Privacy Agent Fixture</h1>"


@app.get("/server/config")
def get_config_endpoint():
    return get_zonui_config()


@app.post("/server/config")
def update_config_endpoint(req: ServerConfigRequest):
    updated = set_zonui_config(
        mode=req.mode,
        endpoint=req.endpoint,
        api_key=req.apiKey,
        model_id=req.modelId
    )
    logger.info(f"Updated server ZonUI configuration: {updated}")
    return updated


@app.post("/server/test-gpu")
def test_gpu_endpoint(req: Optional[ServerConfigRequest] = None):
    """Tests connectivity to the configured GPU endpoint or local model."""
    import urllib.request
    target_endpoint = (req.endpoint if req and req.endpoint else None) or get_zonui_config()["endpoint"]
    target_mode = (req.mode.upper() if req and req.mode else None) or get_zonui_config()["mode"]

    if target_mode == "MOCK":
        return {
            "success": True,
            "mode": "MOCK",
            "message": "Mock Grounding active (~5ms deterministic latency)",
            "latencyMs": 5.0
        }
    
    if target_mode == "LOCAL_MODEL":
        try:
            import torch
            cuda_avail = torch.cuda.is_available()
            device_name = torch.cuda.get_device_name(0) if cuda_avail else "CPU (Fallback)"
            return {
                "success": True,
                "mode": "LOCAL_MODEL",
                "message": f"Local PyTorch accelerator ready on {device_name}",
                "cudaAvailable": cuda_avail,
                "deviceName": device_name
            }
        except Exception as e:
            return {
                "success": False,
                "mode": "LOCAL_MODEL",
                "message": f"Local PyTorch error: {e}"
            }

    # REMOTE_API testing
    start = time.time()
    try:
        # Try a lightweight health ping or sample ground check
        parsed_url = target_endpoint
        health_url = parsed_url.replace("/ground", "/health").replace("/v1/chat/completions", "/health")
        try:
            req_ping = urllib.request.Request(health_url, headers={"User-Agent": "Nexus-Privacy-Agent"})
            with urllib.request.urlopen(req_ping, timeout=6) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                latency = round((time.time() - start) * 1000, 1)
                return {
                    "success": True,
                    "mode": "REMOTE_API",
                    "endpoint": target_endpoint,
                    "message": f"GPU Server reached successfully ({latency}ms)",
                    "latencyMs": latency,
                    "details": data
                }
        except Exception:
            # Fallback direct ping
            req_ping = urllib.request.Request(target_endpoint, headers={"User-Agent": "Nexus-Privacy-Agent"})
            with urllib.request.urlopen(req_ping, timeout=6) as resp:
                latency = round((time.time() - start) * 1000, 1)
                return {
                    "success": True,
                    "mode": "REMOTE_API",
                    "endpoint": target_endpoint,
                    "message": f"GPU Endpoint responded ({latency}ms)",
                    "latencyMs": latency
                }
    except Exception as e:
        latency = round((time.time() - start) * 1000, 1)
        return {
            "success": False,
            "mode": "REMOTE_API",
            "endpoint": target_endpoint,
            "message": f"Could not connect to GPU endpoint: {e}",
            "latencyMs": latency
        }


@app.post("/agent/plan", response_model=PlanResponse)
def plan_agent_actions(req: PlanRequest):
    start_time = time.time()
    task = req.task
    safe_ctx = req.safeContext
    active_mode = os.environ.get("ZONUI_MODE", ZONUI_MODE).upper()
    mode_prefix = f"[{active_mode}]"

    logger.info(f"{mode_prefix} Received planning request for task: '{task}'")

    if not task:
        raise HTTPException(status_code=400, detail="Missing task parameter.")
    if not safe_ctx:
        raise HTTPException(status_code=400, detail="Missing safeContext parameter.")

    redacted_screen = safe_ctx.get("redactedScreenshot")
    if not redacted_screen:
        raise HTTPException(
            status_code=400,
            detail="Security Violation: safeContext must contain 'redactedScreenshot'."
        )

    # 1. Task Planning: Decompose task into atomic steps
    dom_summary = safe_ctx.get("sanitizedDom", []) or safe_ctx.get("dom", [])
    steps = planSteps(task, dom_summary)
    logger.info(f"{mode_prefix} Planned {len(steps)} atomic step(s): {steps}")

    actions: List[ActionItem] = []
    blocked_actions: List[BlockedActionItem] = []
    audit_trail: List[Dict[str, Any]] = []

    # 2. Visual Grounding & Cross-Verification for each step
    for step_idx, step in enumerate(steps):
        logger.info(f"{mode_prefix} Processing Step [{step_idx + 1}/{len(steps)}]: '{step}'")

        # Determine action type and value
        action_type: Literal["click", "type", "scroll", "select"] = "click"
        val = None
        if any(w in step.lower() for w in ["type", "enter", "fill", "input"]):
            action_type = "type"
            if "with " in step.lower():
                val = re.split(r'\bwith\b', step, flags=re.IGNORECASE)[-1].strip("'\" ")
            elif re.search(r'["\']([^"\']+)["\']', step):
                val = re.search(r'["\']([^"\']+)["\']', step).group(1)
            elif " into " in step.lower():
                val = re.split(r'\binto\b', step, flags=re.IGNORECASE)[0]
                val = re.sub(r'^(?:type|enter|input)\s+', '', val, flags=re.IGNORECASE).strip("'\" ")

        try:
            # Ground with ZonUI-3B (enforces SafeContext assertion)
            ground_res = groundElement(redacted_screen, step, safe_ctx)
            bbox = ground_res["bbox"]
            ground_conf = ground_res.get("confidence", 0.9)

            # Cross-verify against DOM and audit log
            verify_res = crossVerify(bbox, safe_ctx, step)

            if verify_res["allowed"]:
                final_conf = round(ground_conf * verify_res["confidence"], 2)
                reasoning = (
                    f"{mode_prefix} ZonUI-3B grounded '{step}' to coordinates {bbox}. "
                    f"{verify_res['reason']}"
                )
                action_item = ActionItem(
                    action=action_type,
                    targetSelector=verify_res["targetSelector"],
                    value=val,
                    groundedBbox=bbox,
                    confidence=final_conf,
                    reasoning=reasoning,
                )
                actions.append(action_item)
                audit_trail.append({
                    "step": step,
                    "status": "APPROVED",
                    "mode": active_mode,
                    "targetSelector": verify_res["targetSelector"],
                    "groundedBbox": bbox,
                    "confidence": final_conf,
                    "details": f"{mode_prefix} {verify_res['reason']}",
                    "timestamp": int(time.time() * 1000),
                })
                logger.info(f"{mode_prefix} Step '{step}' APPROVED -> {verify_res['targetSelector']} (conf: {final_conf})")
            else:
                # Privacy Gate Blocked Action
                blocked_item = BlockedActionItem(
                    step=step,
                    groundedBbox=bbox,
                    reason=f"{mode_prefix} {verify_res['reason']}",
                    auditEntry=verify_res.get("overlapAuditEntry"),
                )
                blocked_actions.append(blocked_item)
                audit_trail.append({
                    "step": step,
                    "status": "BLOCKED_PRIVACY_VIOLATION",
                    "mode": active_mode,
                    "groundedBbox": bbox,
                    "details": f"{mode_prefix} {verify_res['reason']}",
                    "timestamp": int(time.time() * 1000),
                })
                logger.warning(f"{mode_prefix} Step '{step}' BLOCKED by Privacy Gate: {verify_res['reason']}")

        except Exception as e:
            logger.error(f"{mode_prefix} Error executing step '{step}': {e}", exc_info=True)
            audit_trail.append({
                "step": step,
                "status": "ERROR",
                "mode": active_mode,
                "details": str(e),
                "timestamp": int(time.time() * 1000),
            })

    elapsed = round((time.time() - start_time) * 1000, 2)
    is_done = len(actions) > 0 and len(blocked_actions) == 0

    if blocked_actions:
        summary = (
            f"{mode_prefix} Plan partially blocked by Privacy Gate: {len(actions)} action(s) approved, "
            f"{len(blocked_actions)} sensitive action(s) blocked in {elapsed}ms."
        )
    else:
        summary = (
            f"{mode_prefix} Successfully planned and verified {len(actions)} action(s) in {elapsed}ms."
        )

    logger.info(f"{mode_prefix} Planning complete: {summary}")

    return PlanResponse(
        done=is_done,
        summary=summary,
        groundingMode=active_mode,
        actions=actions,
        blockedActions=blocked_actions,
        auditTrail=audit_trail,
    )


if __name__ == "__main__":
    import uvicorn
    print("================================================================================")
    print("Starting Nexus Privacy Agent - Server Agent on http://127.0.0.1:8000")
    print("Interactive Test Page: http://127.0.0.1:8000/demo")
    print("Health Status: http://127.0.0.1:8000/health")
    print("================================================================================")
    uvicorn.run(app, host="127.0.0.1", port=8000)

