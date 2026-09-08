"""
server/test_agent.py - Verification Test Suite for Nexus Server Agent (Phase 4).

Tests:
1. Legitimate task execution: "click the submit button, but do not interact with the Aadhaar or PAN fields"
   -> Confirms ZonUI-3B mock derives realistic coordinates from DOM elements with jitter and varied confidence.
2. Adversarial safety test: "click the Aadhaar field"
   -> Confirms visual grounding to redacted Aadhaar region is intercepted & BLOCKED by verify.py,
      proving privacy enforcement is structural and independent of model weights.
3. Realistic dynamic grounding test across multiple different elements:
   -> Verifies coordinates and confidence scores vary dynamically based on SafeContext inputs.
4. Trust boundary enforcement: Raw unredacted screenshot submission is rejected outright.
5. Low-confidence coordinate warning for non-DOM visual coordinates.
6. End-to-end FastAPI endpoint (/agent/plan) returning validated JSON action plan with [MOCK] logging.
"""

import sys
import json
import time
from typing import Dict, Any

from fastapi.testclient import TestClient

from server.main import app
from server.ground import groundElement, assert_safe_context_screenshot
from server.planner import planSteps
from server.verify import crossVerify

client = TestClient(app)

DUMMY_REDACTED_DATA_URL = (
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk"
    "+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
)

DUMMY_RAW_DATA_URL = (
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8"
    "z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
)


def create_mock_id_safe_context() -> Dict[str, Any]:
    """
    Creates a synthetic SafeContext matching test-fixtures/mock-id-card.html
    after passing through the Phase 3 Privacy Gate.
    """
    return {
        "url": "http://localhost:3456/",
        "timestamp": int(time.time() * 1000),
        "redactedScreenshot": DUMMY_REDACTED_DATA_URL,
        "rawScreenshot": DUMMY_RAW_DATA_URL,
        "sanitizedDom": [
            {
                "tag": "div",
                "role": None,
                "text": "⚠️ SYNTHETIC TEST FIXTURE — ALL DATA IS FAKE / PLACEHOLDER (NOT REAL PII)",
                "attributes": {"class": "banner"},
                "boundingBox": {"x": 260.0, "y": 20.0, "width": 680.0, "height": 38.0}
            },
            {
                "tag": "canvas",
                "role": None,
                "text": "",
                "attributes": {"id": "id-card-canvas", "width": "680", "height": "470"},
                "boundingBox": {"x": 260.0, "y": 78.0, "width": 680.0, "height": 470.0}
            },
            {
                "tag": "button",
                "role": "button",
                "text": "Submit Verification",
                "attributes": {"id": "submit-btn", "class": "submit-btn", "type": "button"},
                "boundingBox": {"x": 504.0, "y": 554.0, "width": 192.0, "height": 42.0}
            }
        ],
        "auditLog": [
            {
                "category": "name",
                "action": "MASK",
                "source": "visual",
                "bbox": {"x": 230.0, "y": 100.0, "width": 180.0, "height": 28.0},
                "timestamp": 1725540000000,
                "details": "Masked detected Name region via solid blackout"
            },
            {
                "category": "aadhaar",
                "action": "MASK",
                "source": "visual",
                "bbox": {"x": 235.0, "y": 153.0, "width": 200.0, "height": 28.0},
                "timestamp": 1725540000001,
                "details": "Masked detected 12-digit Aadhaar pattern via solid blackout"
            },
            {
                "category": "pan",
                "action": "MASK",
                "source": "visual",
                "bbox": {"x": 230.0, "y": 205.0, "width": 180.0, "height": 28.0},
                "timestamp": 1725540000002,
                "details": "Masked detected PAN pattern via solid blackout"
            },
            {
                "category": "address",
                "action": "MASK",
                "source": "visual",
                "bbox": {"x": 235.0, "y": 257.0, "width": 220.0, "height": 28.0},
                "timestamp": 1725540000003,
                "details": "Masked detected Address text via solid blackout"
            },
            {
                "category": "amount",
                "action": "ALLOW",
                "source": "visual",
                "bbox": {"x": 230.0, "y": 317.0, "width": 120.0, "height": 28.0},
                "timestamp": 1725540000004,
                "details": "Non-sensitive control field preserved per policy"
            },
            {
                "category": "unclassified",
                "action": "MASK",
                "source": "visual",
                "bbox": {"x": 250.0, "y": 367.0, "width": 190.0, "height": 28.0},
                "timestamp": 1725540000005,
                "details": "Fail-safe to MASK applied to unclassified text region 'TokenCode'"
            }
        ],
        "summary": {
            "totalDetected": 6,
            "masked": 5,
            "blocked": 0,
            "allowed": 1,
            "pendingAsk": 0
        },
        "policyApplied": {
            "aadhaar": "MASK",
            "pan": "MASK",
            "name": "MASK",
            "address": "MASK",
            "amount": "ALLOW",
            "phone": "MASK",
            "email": "MASK",
            "unclassified": "MASK"
        }
    }


def run_tests():
    print("=" * 80)
    print(">>> PHASE 4 SERVER AGENT VERIFICATION TEST SUITE (ZonUI-3B + Privacy Gate) <<<")
    print("=" * 80)

    safe_ctx = create_mock_id_safe_context()

    # --------------------------------------------------------------------------
    # TEST 1: Legitimate Form Task
    # --------------------------------------------------------------------------
    print("\n[TEST 1] Legitimate Task: 'click the submit button, but do not interact with the Aadhaar or PAN fields'")
    task_1 = "click the submit button, but do not interact with the Aadhaar or PAN fields"
    
    # 1a. Planner
    steps_1 = planSteps(task_1, safe_ctx["sanitizedDom"])
    print(f"  -> Planned steps: {steps_1}")
    assert len(steps_1) == 1, f"Expected 1 planned step, got {len(steps_1)}"
    assert "submit" in steps_1[0].lower(), f"Expected submit action, got {steps_1[0]}"
    assert "aadhaar" not in steps_1[0].lower(), "Planner failed to respect negative directive for Aadhaar"

    # 1b. Grounding (exercises mock with realistic DOM-driven bbox and jitter)
    ground_1 = groundElement(safe_ctx["redactedScreenshot"], steps_1[0], safe_ctx)
    print(f"  -> ZonUI-3B Grounded BBox: {ground_1['bbox']}, confidence: {ground_1['confidence']}")
    # Assert coordinates correlate with actual submit button DOM element (504, 554) with realistic jitter
    assert abs(ground_1["bbox"]["x"] - 504.0) <= 5.0, f"Expected x ~ 504, got {ground_1['bbox']['x']}"
    assert abs(ground_1["bbox"]["y"] - 554.0) <= 5.0, f"Expected y ~ 554, got {ground_1['bbox']['y']}"
    assert 0.90 <= ground_1["confidence"] <= 1.0, f"Expected varied high confidence, got {ground_1['confidence']}"

    # 1c. Cross-verification
    verify_1 = crossVerify(ground_1["bbox"], safe_ctx, steps_1[0])
    print(f"  -> Cross-Verification result: allowed={verify_1['allowed']}, selector='{verify_1['targetSelector']}'")
    assert verify_1["allowed"] is True, "Expected submit button to be allowed"
    assert verify_1["targetSelector"] == "#submit-btn", f"Expected '#submit-btn', got {verify_1['targetSelector']}"
    assert verify_1["isRedactedZone"] is False

    # 1d. Full API call
    res_1 = client.post("/agent/plan", json={"task": task_1, "safeContext": safe_ctx})
    assert res_1.status_code == 200, f"API error: {res_1.text}"
    plan_data_1 = res_1.json()
    print("  -> Full Plan Response:")
    print(json.dumps(plan_data_1, indent=2))
    assert plan_data_1["done"] is True
    assert plan_data_1["groundingMode"] == "MOCK"
    assert len(plan_data_1["actions"]) == 1
    assert plan_data_1["actions"][0]["targetSelector"] == "#submit-btn"
    assert "[MOCK]" in plan_data_1["actions"][0]["reasoning"]
    assert len(plan_data_1["blockedActions"]) == 0
    assert plan_data_1["auditTrail"][0]["mode"] == "MOCK"
    print("  [PASS] Test 1: Legitimate task correctly grounded and planned.")

    # --------------------------------------------------------------------------
    # TEST 2: Adversarial Safety Attack - "click the Aadhaar field"
    # --------------------------------------------------------------------------
    print("\n[TEST 2] Adversarial Security Test: 'click the Aadhaar field'")
    task_2 = "click the Aadhaar field"

    # 2a. Planner
    steps_2 = planSteps(task_2, safe_ctx["sanitizedDom"])
    print(f"  -> Planned steps: {steps_2}")
    assert steps_2 == ["click the aadhaar field"]

    # 2b. Grounding (returns actual redacted Aadhaar region from SafeContext + jitter)
    ground_2 = groundElement(safe_ctx["redactedScreenshot"], steps_2[0], safe_ctx)
    print(f"  -> ZonUI-3B Grounded BBox: {ground_2['bbox']}, confidence: {ground_2['confidence']}")
    assert abs(ground_2["bbox"]["x"] - 235.0) <= 5.0
    assert abs(ground_2["bbox"]["y"] - 153.0) <= 5.0

    # 2c. Cross-verification
    verify_2 = crossVerify(ground_2["bbox"], safe_ctx, steps_2[0])
    print(f"  -> Cross-Verification: allowed={verify_2['allowed']}")
    print(f"  -> Block Reason: {verify_2['reason']}")
    assert verify_2["allowed"] is False, "CRITICAL ERROR: Adversarial click on redacted Aadhaar was NOT blocked!"
    assert verify_2["isRedactedZone"] is True
    assert "AADHAAR" in verify_2["reason"]

    # 2d. Full API call
    res_2 = client.post("/agent/plan", json={"task": task_2, "safeContext": safe_ctx})
    assert res_2.status_code == 200
    plan_data_2 = res_2.json()
    print("  -> Full Adversarial Plan Response:")
    print(json.dumps(plan_data_2, indent=2))
    assert plan_data_2["done"] is False, "Expected done=False due to blocked action"
    assert len(plan_data_2["actions"]) == 0, "Action list must be empty when action is blocked"
    assert len(plan_data_2["blockedActions"]) == 1
    assert plan_data_2["blockedActions"][0]["step"] == "click the aadhaar field"
    assert "AADHAAR" in plan_data_2["blockedActions"][0]["reason"]
    assert plan_data_2["auditTrail"][0]["status"] == "BLOCKED_PRIVACY_VIOLATION"
    print("  [PASS] Test 2: Adversarial instruction targeting redacted Aadhaar was strictly BLOCKED by Privacy Gate!")

    # --------------------------------------------------------------------------
    # TEST 3: Dynamic Variation Test (Proving BBoxes & Confidences Vary Dynamically)
    # --------------------------------------------------------------------------
    print("\n[TEST 3] Realistic Dynamic Mock Variation (Non-Constant BBoxes & Confidences)")
    test_instructions = [
        "click the submit button",
        "click the name field",
        "click the address field",
        "click the total amount",
    ]
    seen_bboxes = []
    seen_confs = []
    for instr in test_instructions:
        g = groundElement(safe_ctx["redactedScreenshot"], instr, safe_ctx)
        seen_bboxes.append(g["bbox"])
        seen_confs.append(g["confidence"])
        print(f"  -> '{instr}' => BBox: {g['bbox']}, Confidence: {g['confidence']}")

    # Verify that all bounding boxes and confidences are distinctly varied
    assert len(set(tuple(b.items()) for b in seen_bboxes)) == len(test_instructions), "Mock returned duplicate bboxes!"
    assert len(set(seen_confs)) >= 2, "Mock returned static non-varying confidence scores!"
    print("  [PASS] Test 3: Verified dynamic variation across diverse SafeContext targets.")

    # --------------------------------------------------------------------------
    # TEST 4: Trust Boundary Violation (Raw Unredacted Screenshot Injection)
    # --------------------------------------------------------------------------
    print("\n[TEST 4] Security Enforcement: Attempting raw screenshot bypass")
    try:
        groundElement(safe_ctx["rawScreenshot"], "click button", safe_ctx)
        print("  [FAIL] Raw screenshot was unexpectedly accepted!")
        sys.exit(1)
    except PermissionError as pe:
        print(f"  -> Successfully intercepted violation: {pe}")
        print("  [PASS] Test 4: Raw unredacted screenshot rejected at trust boundary.")

    # --------------------------------------------------------------------------
    # TEST 5: Low-Confidence Visual Coordinate Warning
    # --------------------------------------------------------------------------
    print("\n[TEST 5] Low-Confidence Warning for non-DOM visual coordinates")
    empty_bbox = {"x": 10.0, "y": 700.0, "w": 40.0, "h": 20.0}
    verify_5 = crossVerify(empty_bbox, safe_ctx, "click blank spot")
    print(f"  -> Confidence: {verify_5['confidence']}, Reason: {verify_5['reason']}")
    assert verify_5["targetSelector"] == "coordinates"
    assert verify_5["confidence"] <= 0.50
    print("  [PASS] Test 5: Blind coordinates penalized with low confidence.")

    print("\n" + "=" * 80)
    print(">>> ALL 5 PHASE 4 VERIFICATION TESTS PASSED SUCCESSFULLY! <<<")
    print("=" * 80)


if __name__ == "__main__":
    run_tests()
