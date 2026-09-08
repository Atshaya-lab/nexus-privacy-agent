# Nexus Privacy Agent — Server Agent (`server/`)

The Server Agent is responsible for receiving the sanitized **SafeContext** from the client-side Chrome extension, decomposing the user's natural language goal into atomic steps, grounding those steps visually into screen coordinates using the **ZonUI-3B** interface, and strictly enforcing the **Cross-Verification Safety Gate** against the privacy audit log before emitting an executable action plan.

---

## 1. Visual Grounding Interface: Mock vs. Real ZonUI-3B

The module `server/ground.py` exposes a single, unified interface:
```python
groundElement(screenshotDataUrl: str, instruction: str, safeContext: Optional[Dict[str, Any]]) -> Dict[str, Any]
# Returns: { "bbox": { "x": float, "y": float, "w": float, "h": float }, "confidence": float }
```
The interface is **100% identical** across all execution modes. Calling code never needs to change when transitioning from development/mock to full GPU production.

### Where to Plug in the Real ZonUI-3B Endpoint

When GPU access is available for the demo or production deployment, switch to the real model simply by setting environment variables:

```bash
# 1. Activate the remote API backend
export ZONUI_MODE="remote_api"

# 2. Point to your hosted GPU inference server (vLLM / Hugging Face Inference Endpoint / local Ollama)
export ZONUI_ENDPOINT="http://<your-gpu-server-ip>:8000/v1/chat/completions"

# 3. (Optional) Provide API authentication key if using a managed cloud endpoint
export ZONUI_API_KEY="hf_xxxxxxxxxxxxxxxxxxxx"

# 4. Model ID
export ZONUI_MODEL_ID="zonghanHZH/ZonUI-3B"
```

In Windows PowerShell:
```powershell
$env:ZONUI_MODE="remote_api"
$env:ZONUI_ENDPOINT="http://your-gpu-instance:8000/v1/chat/completions"
$env:ZONUI_API_KEY="your-token"
```

### Supported Modes:
1. **`ZONUI_MODE=mock` (Default)**:
   - Ultra-fast development/testing runner (< 2ms per step).
   - Generates dynamic, realistic bounding boxes with subtle coordinate jitter and varied confidence scores based on actual DOM elements and audit log entries in the received `SafeContext`.
   - Explicitly logs all calls with `[MOCK] groundElement()`.
2. **`ZONUI_MODE=remote_api`**:
   - Dispatches requests using the exact chat template prompt required by ZonUI-3B:
     ```python
     _SYSTEM = "Based on the screenshot of the page, I give a text description and you give its corresponding location. The coordinate represents a clickable location [x, y] for an element."
     ```
   - Rescales normalized tokens `[x, y]` to original screenshot pixel dimensions.
3. **`ZONUI_MODE=local_model`**:
   - In-process PyTorch inference with `transformers.Qwen2_5_VLForConditionalGeneration` (requires an NVIDIA CUDA GPU with >= 8GB VRAM).

---

## 2. Cross-Verification Safety Gate (`server/verify.py`)

The Server Agent enforces a structural, fail-safe trust boundary:
- **Audit Log Spatial Blacklist**: Every visual grounding box is cross-referenced with entries in `safeContext.auditLog` marked `MASK` or `BLOCK`. If the visual target overlaps a redacted PII zone (such as Aadhaar, PAN, Name, etc.), the action is **outright rejected**:
  - Excluded from the executable `actions` list.
  - Placed into `blockedActions`.
  - Logged with status `BLOCKED_PRIVACY_VIOLATION` in the immutable audit trail.
- **DOM Correlation**: Bounding boxes outside sensitive areas are anchored to the nearest DOM element (e.g. `#submit-btn`), raising confidence to `> 0.90`.
- **Blind Coordinate Penalty**: Visual clicks falling in empty space without nearby DOM nodes are penalized with a low-confidence warning (`0.40`).

---

## 3. Running the Server & Test Suite

### Run the Full Verification Test Suite:
```bash
python -m server.test_agent
# or
npm run server:test
```

### Start the FastAPI Server:
```bash
uvicorn server.main:app --host 127.0.0.1 --port 8000 --reload
# or
npm run server:start
```

### Health Check:
`GET http://localhost:8000/health`
```json
{
  "status": "healthy",
  "service": "Nexus Server Agent",
  "groundingModel": "ZonUI-3B",
  "groundingMode": "MOCK",
  "endpoint": "local",
  "privacyBoundary": "SafeContext-enforced"
}
```

### Plan Endpoint:
`POST http://localhost:8000/agent/plan`
- **Request**: `{ "task": "string", "safeContext": SafeContext }`
- **Response**: `{ "done": bool, "summary": string, "groundingMode": string, "actions": [...], "blockedActions": [...], "auditTrail": [...] }`
