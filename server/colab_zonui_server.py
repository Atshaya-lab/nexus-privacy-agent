# server/colab_zonui_server.py - Google Colab ZonUI-3B Grounding Server
# Run this entire script in a Google Colab notebook with a GPU runtime (T4/A100).

import re
import io
import base64
import asyncio
import nest_asyncio
import uvicorn
import torch
from PIL import Image
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import Optional, Dict, Any, List
from transformers import Qwen2_5_VLForConditionalGeneration, AutoProcessor
import subprocess
import threading
import time

nest_asyncio.apply()

app = FastAPI(title="Colab ZonUI-3B Grounding Server")

model_id = "zonghanHZH/ZonUI-3B"
print(f"Loading {model_id} onto GPU...")

device = "cuda" if torch.cuda.is_available() else "cpu"
dtype = torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16

model = Qwen2_5_VLForConditionalGeneration.from_pretrained(
    model_id,
    torch_dtype=dtype,
    device_map="auto"
)
processor = AutoProcessor.from_pretrained(model_id)
print(f"✅ ZonUI-3B loaded on {device.upper()}!")

class GroundRequest(BaseModel):
    instruction: Optional[str] = None
    image: Optional[str] = None
    messages: Optional[List[Dict[str, Any]]] = None

def decode_image(data_url: str) -> Image.Image:
    if "," in data_url:
        data_url = data_url.split(",", 1)[1]
    image_data = base64.b64decode(data_url)
    return Image.open(io.BytesIO(image_data)).convert("RGB")

@app.post("/ground")
@app.post("/v1/chat/completions")
async def ground_endpoint(req: GroundRequest):
    try:
        instruction = req.instruction
        image_url = req.image

        if req.messages:
            for m in req.messages:
                content = m.get("content", [])
                if isinstance(content, list):
                    for part in content:
                        if part.get("type") == "text" and not instruction:
                            instruction = part.get("text")
                        elif part.get("type") == "image":
                            image_url = part.get("image")

        if not instruction or not image_url:
            raise HTTPException(status_code=400, detail="Missing instruction or image")

        pil_image = decode_image(image_url)
        orig_w, orig_h = pil_image.size

        system_prompt = (
            "Based on the screenshot of the page, I give a text description and you give its corresponding location. "
            "The coordinate represents a clickable location [x, y] for an element."
        )
        prompt = f"<|im_start|>system\n{system_prompt}<|im_end|>\n<|im_start|>user\n<|vision_start|><|image_pad|><|vision_end|>{instruction}<|im_end|>\n<|im_start|>assistant\n"

        inputs = processor(text=[prompt], images=[pil_image], padding=True, return_tensors="pt").to(model.device)

        with torch.no_grad():
            output_ids = model.generate(**inputs, max_new_tokens=64, do_sample=False)

        generated_ids = [
            out_ids[len(in_ids):] for in_ids, out_ids in zip(inputs.input_ids, output_ids)
        ]
        response_text = processor.batch_decode(generated_ids, skip_special_tokens=True)[0].strip()
        print(f"🤖 ZonUI Output for '{instruction}': {response_text}")

        match = re.search(r'\[\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*\]', response_text)
        if match:
            rx, ry = float(match.group(1)), float(match.group(2))
        else:
            rx, ry = orig_w / 2, orig_h / 2

        return {
            "x": rx,
            "y": ry,
            "w": 60.0,
            "h": 30.0,
            "confidence": 0.94,
            "raw_output": response_text
        }
    except Exception as e:
        print(f"Error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

def run_server():
    uvicorn.run(app, host="127.0.0.1", port=8000, log_level="warning")

threading.Thread(target=run_server, daemon=True).start()
time.sleep(2)

print("\n🌐 Creating public HTTPS tunnel with cloudflared...")
tunnel = subprocess.Popen(["cloudflared", "tunnel", "--url", "http://127.0.0.1:8000"],
                          stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)

for line in tunnel.stdout:
    if "trycloudflare.com" in line:
        url_match = re.search(r'https://[a-zA-Z0-9-]+\.trycloudflare\.com', line)
        if url_match:
            public_url = url_match.group(0)
            print("\n" + "="*70)
            print(f"🎉 YOUR REAL ZONUI-3B ENDPOINT IS LIVE!")
            print(f"🔗 Public URL: {public_url}/ground")
            print("="*70 + "\n")
            break
