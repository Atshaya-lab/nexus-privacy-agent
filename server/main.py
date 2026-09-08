"""
server/main.py - FastAPI Service for Nexus Privacy Agent (Server Agent).

Exposes POST /agent/plan to decompose tasks, run ZonUI-3B visual grounding,
cross-verify against the DOM and audit log, and return safe action plans.
"""

import os
import time
import logging
from typing import List, Dict, Any, Optional, Literal
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

# Auto-load .env if present
env_file = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env")
if os.path.exists(env_file):
    with open(env_file, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ[k.strip()] = v.strip().strip('"').strip("'")

from server.ground import groundElement, ZONUI_MODE, ZONUI_ENDPOINT
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
    mode = os.environ.get("ZONUI_MODE", ZONUI_MODE).upper()
    return {
        "status": "healthy",
        "service": "Nexus Server Agent",
        "groundingModel": "ZonUI-3B",
        "groundingMode": mode,
        "endpoint": ZONUI_ENDPOINT if mode == "REMOTE_API" else "local",
        "privacyBoundary": "SafeContext-enforced",
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
