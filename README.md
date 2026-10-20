# Hoard

**Search and sweep your screenshot pile with open AI models that run in your browser.**

You take screenshots so you don't have to remember things: the Wi‑Fi password, where you parked, a boarding pass, an address someone texted you. Then you have 4,000 of them and you can't find any of it.

Hoard reads the folder for you, slowly and steadily, in a background tab:

- **Search by memory.** "wifi password", "where did I park", "that sunset photo". Each screenshot is OCR'd and embedded twice (its text and its picture), and search mixes keywords, meaning and looks.
- **Sweep the junk.** Duplicates, one-time codes that died minutes after you got them, boarding passes for flights you already took, and accidental screenshots of your home screen. One click moves them into a `Swept by Hoard` subfolder. Nothing is ever deleted.
- **Ask.** "when is rent due?" Gemma 3 reads the best-matching screenshots and answers in a sentence, showing which screenshot it used.

Everything runs on your device: no account, no server, no analytics. After the first visit it works offline.

**Live:** https://hoard.onrender.com <!-- TODO: confirm the Render URL after the first deploy --> (Chrome or Edge on a laptop for the full experience; **Try a sample pile** needs no screenshots of your own)

## The models

| Job | Model | Licence | Size |
| --- | --- | --- | --- |
| Read the text | Tesseract 5 LSTM (`eng`, best_int) via tesseract.js | Apache-2.0 | 5 MB |
| Picture search + screenshot kind | SigLIP base patch16-224 (`Xenova/siglip-base-patch16-224`, int8) | Apache-2.0 | 210 MB |
| Meaning search over the text | gte-small (`Xenova/gte-small`, int8) | MIT | 34 MB |
| Ask (optional) | Gemma 3 1B (WebGPU, 4-bit) or 270M (CPU, fp16) | Gemma terms | 790 / 590 MB |

All of it runs through [Transformers.js](https://github.com/huggingface/transformers.js) and ONNX Runtime Web in a Web Worker, and the WASM runtimes are served from this site, not a CDN.

## How search ranks

For a query, Hoard computes three scores for every screenshot:

1. **Keywords:** BM25 over the OCR text, with the last word matched as a prefix so results appear while you type.
2. **Meaning:** cosine between the query and the OCR text, both embedded by gte-small.
3. **Picture:** cosine between the query (SigLIP's text tower) and the screenshot (SigLIP's image tower).

The two cosine scores are converted to z-scores across the whole pile ("how unusually close is this one?"), clipped at zero, and mixed with the keyword score: `1.0 × keywords + 0.75 × meaning + 1.5 × picture`. The weights were picked on 30 tuning queries over the sample pile and then checked on 20 held-out queries.

| Signal | Tuning hit@1 | Held-out hit@1 |
| --- | --- | --- |
| Keywords only | 0.70 | 0.75 |
| Meaning only (gte-small) | 0.83 | 0.85 |
| Picture only (SigLIP) | 0.90 | 0.85 |
| All three | **0.93** | **1.00** |

The sample pile is synthetic (drawn on a canvas, with large clean text), so treat these as a sanity check, not a benchmark. Run them yourself at `/eval.html` with `npm run dev`.

## Ask

Ask runs the same search, then gives Gemma 3 1B the OCR text of the best match (plus up to two more if they scored within 70% of it), labelled with the kind of screenshot and its date, and asks for the exact detail in one sentence. The screenshots it read are shown under the answer, so you can check it.

On 10 questions over the sample pile, on a laptop's integrated GPU (Intel Xe, WebGPU):

- **7 right** (Wi‑Fi password, payment amount, hotel confirmation number, dentist time, tracking number, rent due date, party address)
- **1 half right** (the gate: "B32" is in the answer, garbled with the seat)
- **1 declined** ("where did I park?" → "I couldn't find that", although the right note was the top result)
- **1 wrong** ("who is bringing snacks?" → the other person; OCR can't tell which chat bubbles are yours)
- median **8 seconds** per answer

An earlier prompt that always showed it the top three screenshots got 5 of the first 8 questions right (this one gets 6 of those 8) and invented details, such as a payment amount, from the screenshots that didn't match. That's why it now sees fewer. It also took a median of 13 seconds.

## Speed

On the same laptop at the default "Steady" pace, Hoard indexes the sample pile at about **1.7 seconds per screenshot** (OCR and the two embeddings overlap in separate workers), so a thousand screenshots take roughly half an hour, in the background. "Sloth" pace adds a nap between screenshots to keep the fans quiet; "Sprint" runs four at a time with two OCR workers.

## Sweep rules

- **Duplicates:** perceptual hash (dHash) within 12 bits *and* OCR text with Jaccard ≥ 0.8, or near-identical hash and SigLIP embedding for screenshots with no text. Keeps the copy with the most text.
- **Old one-time codes:** short messages with "verification code", "OTP", "login code" and a 4–8 digit number, older than two days.
- **Expired tickets:** words that only appear on tickets (boarding pass, gate + seat, admission, "show this at the door") and every date on it in the past.
- **Accidental:** almost no variation in the image, or a home screen with little text.

On the sample pile it flags 11 of the 11 screenshots it should, and nothing else.

## Run it

```bash
npm install
npm run dev        # http://localhost:5177, eval at /eval.html
npm run build      # static site in dist/
```

`render.yaml` deploys it as a free Render static site with the cross-origin isolation headers ONNX Runtime needs for multithreading.

## Browser support

- **Chrome / Edge (desktop):** everything, including moving swept files and noticing new screenshots on the next visit.
- **Firefox / Safari:** search and ask work on a folder you pick each visit; Sweep hides screenshots and gives you their names to delete yourself, because these browsers can't write to your folders.

## Licence

MIT. Model licences are listed above.
