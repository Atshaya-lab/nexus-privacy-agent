---
base_model:
- Qwen/Qwen2.5-VL-3B-Instruct
language:
- en
license: apache-2.0
tags:
- GUI
- multimodal
pipeline_tag: image-text-to-text
library_name: transformers
---

ZonUI-3B — A lightweight, resolution-aware GUI grounding model trained with only 24K samples on a single RTX 4090.

This model was presented in the paper [ZonUI-3B: A Lightweight Vision-Language Model for Cross-Resolution GUI Grounding](https://huggingface.co/papers/2506.23491).

## Abstract
In this paper, we present ZonUI-3B, a lightweight Vision-Language Model (VLM) that can be fully trained on a single consumer-grade GPU (RTX 4090) while delivering performance comparable to significantly larger models on GUI grounding tasks. The model incorporates several key innovations: (i) combine cross-platform, multi-resolution dataset of 24K examples from diverse sources including mobile, desktop, and web GUI screenshots to effectively address data scarcity in high-resolution desktop environments; (ii) a two-stage fine-tuning strategy, where initial cross-platform training establishes robust GUI understanding, followed by specialized fine-tuning on high-resolution data to significantly enhance model adaptability; and (iii) data curation and redundancy reduction strategies, demonstrating that randomly sampling a smaller subset with reduced redundancy achieves performance comparable to larger datasets, emphasizing data diversity over sheer volume. Empirical evaluation on standard GUI grounding benchmarks, including ScreenSpot, ScreenSpot-v2, and the challenging ScreenSpot-Pro, highlights ZonUI-3B's exceptional accuracy, achieving 84.9% on ScreenSpot and 86.4% on ScreenSpot-v2, surpassing prior models under 4B parameters. Ablation studies validate the critical role of balanced sampling and two-stage fine-tuning in enhancing robustness, particularly in high-resolution desktop scenarios. The ZonUI-3B is available at: this https URL

- **Repository:** https://github.com/Han1018/ZonUI-3B
- **Paper (arXiv):** https://arxiv.org/abs/2506.23491

## ⭐ Quick start

1. Load ZonUI-3B Model
```python
import ast
import torch
from PIL import Image, ImageDraw
from transformers import Qwen2_5_VLForConditionalGeneration, AutoTokenizer, AutoProcessor
from transformers.generation import GenerationConfig
from transformers.models.qwen2_vl.image_processing_qwen2_vl_fast import smart_resize

def draw_point(image_input, point=None, radius=5):
    """Draw a point on the image at normalized coordinates [0-1]"""
    if isinstance(image_input, str):
        image = Image.open(image_input)
    else:
        image = image_input.copy()
    
    if point:
        x, y = point[0] * image.width, point[1] * image.height
        ImageDraw.Draw(image).ellipse((x - radius, y - radius, x + radius, y + radius), fill='red')
    
    return image

# Load ZonUI-3B model
model = Qwen2_5_VLForConditionalGeneration.from_pretrained(
    "zonghanHZH/ZonUI-3B",
    device_map="auto", 
    torch_dtype=torch.bfloat16,
    attn_implementation="flash_attention_2"
).eval()

processor = AutoProcessor.from_pretrained("zonghanHZH/ZonUI-3B")
tokenizer = AutoTokenizer.from_pretrained("zonghanHZH/ZonUI-3B", trust_remote_code=True)

# Set generation config
generation_config = GenerationConfig.from_pretrained("zonghanHZH/ZonUI-3B", trust_remote_code=True)
generation_config.max_length = 4096
generation_config.do_sample = False
generation_config.temperature = 0.0
model.generation_config = generation_config

min_pixels = 256*28*28
max_pixels = 1280*28*28
```

2. UI Grounding Example
```python
# Example usage
img_url = './app_store.png'  # Path to your screenshot
query = 'Get OmniFocus 4'    # Text description of the element to find

# Load and prepare image
image = Image.open(img_url).convert('RGB')

# Calculate resized dimensions
resized_height, resized_width = smart_resize(
    image.height,
    image.width,
    factor=processor.image_processor.patch_size * processor.image_processor.merge_size,
    min_pixels=min_pixels,
    max_pixels=max_pixels,
)
resized_image = image.resize((resized_width, resized_height))

# Prepare messages for the model
_SYSTEM = "Based on the screenshot of the page, I give a text description and you give its corresponding location. The coordinate represents a clickable location [x, y] for an element."

messages = [
    {
        "role": "user",
        "content": [
            {"type": "text", "text": _SYSTEM},
            {"type": "image", "image": img_url, "min_pixels": min_pixels, "max_pixels": max_pixels},
            {"type": "text", "text": query}
        ],
    }
]

# Process input
text = processor.apply_chat_template(
    messages, tokenize=False, add_generation_prompt=True,
)

inputs = processor(
    text=[text],
    images=[resized_image],
    return_tensors="pt",
    training=False
).to("cuda")

# Generate prediction
generated_ids = model.generate(**inputs)
generated_ids_trimmed = [
    out_ids[len(in_ids) :] for in_ids, out_ids in zip(inputs.input_ids, generated_ids)
]
output_text = processor.batch_decode(
    generated_ids_trimmed, skip_special_tokens=True, clean_up_tokenization_spaces=False
)[0].strip()

# print(f"Raw output: {output_text}")

# Parse coordinates
try:
    coordinates = ast.literal_eval(output_text)
    if len(coordinates) == 2:
        click_xy = [coord / resized_width if i == 0 else coord / resized_height 
                   for i, coord in enumerate(coordinates)]
    else:
        raise ValueError("Unexpected coordinate format")
    absolute_x = click_xy[0] * image.width
    absolute_y = click_xy[1] * image.height
    
    print(f"Normalized coordinates: {click_xy}")
    print(f"Predicted text: {absolute_x}, {absolute_y}")
    
    # Visualize result
    result_image = draw_point(img_url, click_xy, radius=10)
    result_image.save("./quick_start_output.png")
    print("Result saved to quick_start_output.png")
    display(result_image)
except Exception as e:
    print(f"Error parsing coordinates: {e}")
```

## 🎉 Main Results

### ScreenSpot

| Grounding Model          | Avg Score  | Mobile-Text | Mobile-Icon | Desktop-Text | Desktop-Icon | Web-Text | Web-Icon |
|--------------------------|--------|-------------|-------------|---------------|----------------|-----------|-----------|
| **General Models**       |        |             |             |               |                |           |           |
| Qwen2.5-VL-3B            | 55.5   | -           | -           | -             | -              | -         | -         |
| InternVL3-8B             | 79.5   | -           | -           | -             | -              | -         | -         |
| Claude3.5 Sonnet         | 83.0   | -           | -           | -             | -              | -         | -         |
| Gemini-2 Flash           | 84.0   | -           | -           | -             | -              | -         | -         |
| Qwen2.5-VL-7B            | 84.7   | -           | -           | -             | -              | -         | -         |
| **GUI-specific Models**  |        |             |             |               |                |           |           |
| CogAgent-18B             | 47.4   | 67.0        | 24.0        | 74.2          | 20.0           | 70.4      | 28.6      |
| SeeClick-9.6B            | 53.4   | 78.0        | 52.0        | 72.2          | 30.0           | 55.7      | 32.5      |
| OmniParser               | 73.0   | 93.9        | 57.0        | 91.3          | 63.6           | 81.3      | 51.0      |
| UGround-7B               | 73.3   | 82.8        | 60.3        | 82.5          | 63.6           | 80.4      | 70.4      |
| ShowUI-2B                | 75.0   | 91.6        | 69.0        | 81.8          | 59.0           | 83.0      | 65.5      |
| UI-TARS-2B               | 82.3   | 93.0        | 75.5        | 90.7          | 68.6           | 84.3      | 74.8      |
| OS-Atlas-7B              | 82.5   | 93.0        | 72.9        | 91.8          | 62.9           | 90.9      | 74.3      |
| Aguvis-7B                | 84.4   | 95.6        | 77.7        | 93.8          | 67.1           | 88.3      | 75.2      |
| **ZonUI-3B**          | **84.9** | **96.3**    | **81.6**    | **93.8**      | **74.2**       | 89.5      | 74.2      |


### ScreenSpot-v2

| Grounding Model          | Avg Score  | Mobile-Text | Mobile-Icon | Desktop-Text | Desktop-Icon | Web-Text | Web-Icon |
|--------------------------|--------|-------------|-------------|---------------|----------------|-----------|-----------|
| **General Models**       |        |             |             |               |                |           |           |
| InternVL3-8B             | 81.4   | -           | -           | -             | -              | -         | -         |
| **GUI-specific Models**  |        |             |             |               |                |           |           |
| SeeClick-9.6B            | 55.1   | 78.4        | 50.7        | 70.1          | 29.3           | 55.2      | 32.5      |
| UGround-7B               | 76.3   | 84.5        | 61.6        | 85.1          | 61.4           | 84.6      | 71.9      |
| ShowUI-2B                | 77.3   | 92.1        | 75.4        | 78.9          | 59.3           | 84.2      | 61.1      |
| OS-Atlas-7B              | 84.1   | 95.1        | 75.8        | 90.7          | 63.5           | 90.6      | 77.3      |
| UI-TARS-2B               | 84.7   | 95.2        | 79.1        | 90.7          | 68.6           | 87.2      | 78.3      |
| **ZonUI-3B**        | **86.4** | **97.9**    | **84.8**    | **93.8**      | **75.0**       | **91.0**  | 75.8      |

## 🫶 Acknowledgement
We would like to acknowledge [ShowUI](https://github.com/showlab/ShowUI) for making their code and data publicly available, which was instrumental to our development.

## ✍️ BibTeX
If our work contributes to your research, we would appreciate it if you could cite our paper.

```
@misc{hsieh2025zonui3b,
  title        = {ZonUI-3B: A Lightweight Vision-Language Model for Cross-Resolution GUI Grounding},
  author       = {Hsieh, ZongHan and Wei, Tzer-Jen and Yang, ShengJing},
  year         = {2025},
  howpublished = {\url{https://arxiv.org/abs/2506.23491}},
  note         = {arXiv:2506.23491 [cs.CV], version 2, last revised 1 Jul 2025}
}
```