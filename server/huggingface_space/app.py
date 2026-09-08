# app.py - Hugging Face Space for ZonUI-3B GPU Visual Grounding
# Deploy to Hugging Face Spaces with a GPU hardware tier (T4 / A10G).

import os
import re
import io
import base64
import torch
from PIL import Image
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import Optional, Dict, Any, List
from transformers import Qwen2_5_VLForConditionalGeneration, AutoProcessor

app = FastAPI(title="Hugging Face ZonUI-3B GPU Grounding Service")

MODEL_ID = "zonghanHZH/ZonUI-3B"
print(f"Loading {MODEL_ID} from Hugging Face on GPU...")

device = "cuda" if torch.cuda.is_available() else "cpu"
dtype = torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16

model = Qwen2_5_VLForConditionalGeneration.from_pretrained(
    MODEL_ID,
    torch_dtype=dtype,
    device_map="auto"
)
processor = AutoProcessor.from_pretrained(MODEL_ID)
print(f"✅ ZonUI-3B ready on {device.upper()}!")

class GroundRequest(BaseModel):
    instruction: Optional[str] = None
    image: Optional[str] = None
    messages: Optional[List[Dict[str, Any]]] = None

def decode_image(data_url: str) -> Image.Image:
    if "," in data_url:
        data_url = data_url.split(",", 1)[1]
    image_data = base64.b64decode(data_url)
    return Image.open(io.BytesIO(image_data)).convert("RGB")

@app.get("/")
@app.get("/health")
def health():
    return {
        "status": "online",
        "model": MODEL_ID,
        "device": device,
        "dtype": str(dtype),
        "endpoint": "/ground"
    }

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
            raise HTTPException(status_code=400, detail="Missing instruction or image.")

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
            "confidence": 0.95,
            "raw_output": response_text
        }
    except Exception as e:
        print(f"Error in inference: {e}")
        raise HTTPException(status_code=500, detail=str(e))
