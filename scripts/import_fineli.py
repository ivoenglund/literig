#!/usr/bin/env python3
"""Download auditable English food/nutrient data from Fineli without writing to the DB.
Run: python3 scripts/import_fineli.py
Writes: migrations/fineli_import_review.json
"""
import json
from pathlib import Path
from urllib.parse import quote
from urllib.request import Request, urlopen

API = "https://fineli.fi/fineli/api/v1"
# English recipe ingredient -> Fineli search query. Confirmed matches are reviewed in output.
QUERIES = {
    # target: (Fineli search term, required English words in the candidate name)
    "tofu": ("tofu", "tofu"), "lentils, cooked": ("linssi", "lentil"), "broccoli": ("parsakaali", "broccoli"),
    "rolled oats": ("kaurahiutale", "oat"), "potato, boiled": ("peruna", "potato"), "spinach": ("pinaatti", "spinach"),
    "cilantro": ("korianteri", "coriander"), "orange": ("appelsiini", "orange"), "blueberries": ("mustikka", "blueberr"),
    "banana": ("banaani", "banana"), "tomato": ("tomaatti", "tomato"), "brown rice, cooked": ("täysjyväriisi", "brown rice"),
}

def get(path):
    req = Request(API + path, headers={"User-Agent": "LifeOnPlants/1.0"})
    with urlopen(req, timeout=30) as response:
        return json.load(response)

def english(record):
    return (record.get("name") or {}).get("en") or ""

def choose(required, candidates):
    # Do not silently accept dishes; choose only raw-food candidates and require a clear English name match.
    q = required.lower().split()
    foods = [x for x in candidates if (x.get("type") or {}).get("code") == "FOOD"]
    scored = sorted(foods, key=lambda x: sum(token in english(x).lower() for token in q), reverse=True)
    if not scored:
        return None
    # A multi-word query needs every meaningful word to appear in the English candidate name.
    score = sum(token in english(scored[0]).lower() for token in q)
    return scored[0] if score == len(q) else None

def main():
    components = get("/components")
    result = {"source": "Fineli API / Finnish Institute for Health and Welfare", "license": "CC BY 4.0", "basis": "100 g", "components": [], "foods": [], "unmatched": []}
    for index, c in enumerate(components):
        result["components"].append({"index": index, "code": c["code"], "name": c["name"].get("en"), "unit": c["unitOfMeasurement"]["abbreviation"].get("en")})
    for target, (search_term, required) in QUERIES.items():
        candidate = choose(required, get("/foods?q=" + quote(search_term)))
        if not candidate:
            result["unmatched"].append({"target": target, "query": search_term, "required_english": required})
            continue
        detail = get("/foods/" + str(candidate["id"]))
        result["foods"].append({
            "target": target, "fineli_id": detail["id"], "english_name": english(detail),
            "food_type": detail["type"]["code"], "basis_g": detail.get("mass"),
            "preparation": [x["description"].get("en") for x in detail.get("preparationMethod", [])],
            "nutrients": {components[i]["code"]: value for i, value in enumerate(detail.get("data", [])) if value is not None},
        })
    out = Path(__file__).resolve().parents[1] / "migrations" / "fineli_import_review.json"
    out.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    print(f"Wrote {out}: {len(result['foods'])} candidates, {len(result['unmatched'])} unmatched")

if __name__ == "__main__":
    main()
