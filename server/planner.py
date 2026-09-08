"""
server/planner.py - Lightweight Task Planner for Nexus Privacy Agent.

Decomposes high-level natural language tasks into an ordered sequence of
atomic grounding instructions for ZonUI-3B.
"""

import re
from typing import List, Dict, Any


def planSteps(task: str, domSummary: List[Dict[str, Any]]) -> List[str]:
    """
    Decomposes a task into atomic grounding steps.
    
    Args:
        task: High-level natural language task description.
        domSummary: Array of sanitized DomNode objects from SafeContext.
        
    Returns:
        List of atomic grounding instructions, e.g. ["click the submit button"].
    """
    if not task or not task.strip():
        return []

    clean_task = task.strip()
    norm_task = clean_task.lower()

    # 1. Check for explicit negative directives (e.g. "do not interact with ...")
    # Separate the positive action from the negative restriction
    positive_part = clean_task
    negative_part = ""
    
    neg_match = re.search(r'\b(?:but\s+)?(?:do\s+not|don\'t|never|without)\s+([^,.]+)', norm_task)
    if neg_match:
        # Extract restriction
        negative_part = neg_match.group(1)
        # Remove restriction clause to isolate the positive goal
        positive_part = re.sub(r'\b(?:but\s+)?(?:do\s+not|don\'t|never|without)\s+[^,.]+', '', clean_task, flags=re.IGNORECASE).strip()

    # 2. Check for adversarial direct instruction (e.g. "click the aadhaar field")
    # If the user directly targets a sensitive field, plan that atomic step so downstream
    # cross-verification can catch and block it.
    if re.search(r'\b(?:click|tap|select|inspect)\s+(?:the\s+)?(aadhaar|pan|card|token)', norm_task):
        for field in ["aadhaar", "pan"]:
            if field in norm_task and not neg_match:
                return [f"click the {field} field"]

    # 3. Handle sequential compound instructions ("and then", "then", "and", "followed by")
    split_pattern = r'\b(?:then|and\s+then|followed\s+by)\b|;'
    sub_tasks = [s.strip() for s in re.split(split_pattern, positive_part) if s.strip()]

    steps: List[str] = []
    
    for sub in sub_tasks:
        sub_norm = sub.lower()

        # 1. Search queries: "search for X" or "search X"
        search_match = re.search(r'^\s*search(?:\s+for)?\s+["\']?([^"\']+)["\']?\s*$', sub, flags=re.IGNORECASE)
        if search_match:
            query = search_match.group(1).strip()
            steps.append(f'type "{query}" into search input')
            steps.append('click search button')
            continue

        # 2. Explicit typing: "type X into Y" or "fill Y with X"
        type_into_match = re.search(r'\b(?:type|enter|input)\s+["\']?([^"\']+)["\']?\s+(?:into|in|to)\s+(?:the\s+)?([^,.]+)', sub, flags=re.IGNORECASE)
        fill_with_match = re.search(r'\bfill\s+(?:the\s+)?([^,.]+)\s+with\s+["\']?([^"\']+)["\']?', sub, flags=re.IGNORECASE)
        if type_into_match:
            val = type_into_match.group(1).strip()
            field = type_into_match.group(2).strip()
            steps.append(f'type "{val}" into {field}')
            continue
        elif fill_with_match:
            field = fill_with_match.group(1).strip()
            val = fill_with_match.group(2).strip()
            steps.append(f'type "{val}" into {field}')
            continue

        # 3. Match submit / button action
        if any(w in sub_norm for w in ["submit", "finish", "complete", "send", "verify"]):
            # Find matching DOM button text or default
            button_label = "submit button"
            for node in domSummary:
                tag = (node.get("tag") or "").lower()
                text = (node.get("text") or "").lower()
                if "submit" in text or "verify" in text or tag == "button":
                    button_label = node.get("text") or "submit button"
                    break
            steps.append(f"click the {button_label.strip()}")

        # 4. Match form fill / typing action without value
        elif any(w in sub_norm for w in ["fill", "type", "enter", "input"]):
            matched_field = None
            for field in ["name", "address", "phone", "email", "amount", "search"]:
                if field in sub_norm and field not in negative_part:
                    matched_field = field
                    steps.append(f"click the {field} field")
                    break
            if not matched_field:
                steps.append(sub)

        # 5. Match explicit click directive
        elif "click" in sub_norm:
            cleaned = re.sub(r'^(?:please\s+)?click\s+(?:on\s+)?', 'click ', sub, flags=re.IGNORECASE).strip()
            if cleaned:
                steps.append(cleaned)
        else:
            # Default fallback: treat sub-task as atomic instruction
            steps.append(sub)

    # 4. If no explicit steps extracted, synthesize from DOM summary
    if not steps:
        # If task mentions form submission, locate inputs followed by submit button
        if "form" in norm_task or "submit" in norm_task:
            inputs = []
            buttons = []
            for node in domSummary:
                tag = (node.get("tag") or "").lower()
                attrs = node.get("attributes", {})
                node_type = attrs.get("type", "").lower()
                if tag in ["input", "textarea"] and node_type not in ["hidden", "submit"]:
                    inputs.append(node)
                elif tag == "button" or node_type == "submit":
                    buttons.append(node)

            for inp in inputs:
                label = inp.get("attributes", {}).get("name") or inp.get("attributes", {}).get("placeholder") or "input"
                steps.append(f"click the {label} field")

            for btn in buttons:
                label = btn.get("text") or "submit button"
                steps.append(f"click the {label.strip()}")
        else:
            steps.append(clean_task)

    return steps
