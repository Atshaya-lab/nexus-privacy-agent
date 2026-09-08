"""
server/verify.py - Cross-Verification Safety Gate for Nexus Privacy Agent.

Validates visual grounding coordinates produced by ZonUI-3B against:
1. SafeContext.auditLog: Outright REJECTS any action targeting a redacted PII zone.
2. SafeContext.sanitizedDom: Correlates coordinate clicks with actual DOM elements
   and penalizes blind coordinate actions that lack nearby DOM nodes.
"""

import math
from typing import Dict, Any, Optional, List, Tuple


def _get_bbox_props(b: Dict[str, Any]) -> Tuple[float, float, float, float, float, float]:
    """Extracts (x, y, w, h, cx, cy) from bbox dict."""
    x = float(b.get("x", 0))
    y = float(b.get("y", 0))
    w = float(b.get("w", b.get("width", 0)))
    h = float(b.get("h", b.get("height", 0)))
    cx = x + w / 2.0
    cy = y + h / 2.0
    return x, y, w, h, cx, cy


def _point_in_bbox(px: float, py: float, bbox: Dict[str, Any], margin: float = 5.0) -> bool:
    """Checks if a point (px, py) falls inside bbox with an optional margin."""
    x, y, w, h, _, _ = _get_bbox_props(bbox)
    return (x - margin <= px <= x + w + margin) and (y - margin <= py <= y + h + margin)


def _bbox_intersection_area(b1: Dict[str, Any], b2: Dict[str, Any]) -> float:
    """Calculates intersection area between two bounding boxes."""
    x1, y1, w1, h1, _, _ = _get_bbox_props(b1)
    x2, y2, w2, h2, _, _ = _get_bbox_props(b2)

    inter_x1 = max(x1, x2)
    inter_y1 = max(y1, y2)
    inter_x2 = min(x1 + w1, x2 + w2)
    inter_y2 = min(y1 + h1, y2 + h2)

    if inter_x2 > inter_x1 and inter_y2 > inter_y1:
        return (inter_x2 - inter_x1) * (inter_y2 - inter_y1)
    return 0.0


def _build_dom_selector(node: Dict[str, Any]) -> str:
    """Synthesizes a precise CSS selector for a DOM node."""
    attrs = node.get("attributes", {})
    tag = node.get("tag", "div").lower()

    if attrs.get("id"):
        return f"#{attrs['id']}"
    if attrs.get("name"):
        return f"{tag}[name='{attrs['name']}']"
    if attrs.get("class"):
        classes = ".".join(attrs["class"].split())
        return f"{tag}.{classes}"
    if node.get("role"):
        return f"{tag}[role='{node['role']}']"
    return tag


def crossVerify(
    groundedBbox: Dict[str, Any],
    safeContext: Dict[str, Any],
    instruction: str,
    proximity_threshold: float = 120.0
) -> Dict[str, Any]:
    """
    Performs safety cross-verification on a visually grounded bounding box.

    Returns:
        {
            "allowed": bool,
            "reason": str,
            "targetSelector": str,
            "matchedDomNode": Optional[dict],
            "confidence": float,
            "isRedactedZone": bool,
            "distanceToDom": Optional[float]
        }
    """
    gx, gy, gw, gh, gcx, gcy = _get_bbox_props(groundedBbox)

    # --------------------------------------------------------------------------
    # 1. HARD SAFETY CHECK: Audit Log Overlap Verification
    # --------------------------------------------------------------------------
    audit_log = safeContext.get("auditLog", [])
    for entry in audit_log:
        action = entry.get("action", "").upper()
        # Redacted or Masked regions must NEVER be targeted
        if action in ["MASK", "BLOCK"]:
            abox = entry.get("bbox", {})
            if not abox:
                continue

            # Check point containment of center point
            center_inside = _point_in_bbox(gcx, gcy, abox, margin=8.0)
            # Check bounding box intersection
            inter_area = _bbox_intersection_area(groundedBbox, abox)
            box_area = max(gw * gh, 1.0)
            overlap_ratio = inter_area / box_area

            if center_inside or overlap_ratio > 0.15:
                category = entry.get("category", "SENSITIVE_PII").upper()
                return {
                    "allowed": False,
                    "reason": (
                        f"BLOCKED: Visual grounding target ({groundedBbox}) overlaps redacted PII region "
                        f"[{category}] (bbox: {abox}) per SafeContext audit log. "
                        f"Hard privacy gate enforced: Agent cannot interact with hidden sensitive data."
                    ),
                    "targetSelector": "BLOCKED_PII_ZONE",
                    "matchedDomNode": None,
                    "confidence": 0.0,
                    "isRedactedZone": True,
                    "overlapAuditEntry": entry
                }

    # --------------------------------------------------------------------------
    # 2. DOM CORRELATION: Find nearest sanitized DOM node
    # --------------------------------------------------------------------------
    dom_nodes = safeContext.get("sanitizedDom", []) or safeContext.get("dom", [])
    best_node = None
    min_distance = float("inf")

    for node in dom_nodes:
        # If node text is explicitly marked [REDACTED:...] check overlap
        node_text = node.get("text", "")
        nbox = node.get("boundingBox", {})
        if not nbox:
            continue

        nx, ny, nw, nh, ncx, ncy = _get_bbox_props(nbox)
        dist = math.hypot(gcx - ncx, gcy - ncy)

        if "[REDACTED:" in node_text:
            if _point_in_bbox(gcx, gcy, nbox) or _bbox_intersection_area(groundedBbox, nbox) > 0:
                return {
                    "allowed": False,
                    "reason": f"BLOCKED: Target DOM node is explicitly redacted: '{node_text}'.",
                    "targetSelector": "BLOCKED_PII_DOM",
                    "matchedDomNode": node,
                    "confidence": 0.0,
                    "isRedactedZone": True,
                }

        if dist < min_distance:
            min_distance = dist
            best_node = node

    # --------------------------------------------------------------------------
    # 3. PROXIMITY EVALUATION
    # --------------------------------------------------------------------------
    if best_node and min_distance <= proximity_threshold:
        selector = _build_dom_selector(best_node)
        return {
            "allowed": True,
            "reason": f"Verified: Grounded target correlates with DOM element '{selector}' (distance: {min_distance:.1f}px).",
            "targetSelector": selector,
            "matchedDomNode": best_node,
            "confidence": 0.95,
            "isRedactedZone": False,
            "distanceToDom": min_distance
        }

    # --------------------------------------------------------------------------
    # 4. LOW-CONFIDENCE FALLBACK: No nearby DOM node found
    # --------------------------------------------------------------------------
    return {
        "allowed": True,
        "reason": f"Warning: No matching DOM node within {proximity_threshold}px (closest: {min_distance:.1f}px). Visual coordinate fallback.",
        "targetSelector": "coordinates",
        "matchedDomNode": None,
        "confidence": 0.40,
        "isRedactedZone": False,
        "distanceToDom": min_distance if best_node else None
    }
