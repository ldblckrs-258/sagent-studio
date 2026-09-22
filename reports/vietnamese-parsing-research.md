# Nghiên cứu: thư viện parse tiếng Việt thay thế?

**Ngày:** 2026-09-22 · **Bối cảnh:** tiếp theo `reports/rag-test-round4.md` (khuyết điểm F1–F6)
**Câu hỏi:** có thư viện nào parse/ xử lý tiếng Việt tốt hơn stack hiện tại (`pdfjs-dist` + regex thủ công) không?
**Ràng buộc:** app React/Vite chạy **thuần client** (`src/rag/ingest.ts`, `src/rag/pdf.ts:57`), không server,
không Python, không native addon. Mọi ứng viên phải chạy được trong browser (JS/WASM).

---

## 1. Kết luận nhanh

| # | Câu hỏi | Trả lời |
|---|---|---|
| Có drop-in thay thế giúp parse tiếng Việt "tốt hơn" không? | **Không.** Không có thư viện nào giải quyết trực tiếp F1–F5. |
| Lỗi có phải do "parse tiếng Việt" không? | **Không.** F1–F3 là lỗi **PDF font/layout**, không phải ngôn ngữ. F4/F5 mới là tiếng Việt, nhưng không lib browser nào làm sẵn. |
| Đổi PDF engine (pdf.js → MuPDF) có đáng không? | **Chỉ khi chấp nhận AGPL**, và phải đo thực tế: cải thiện F1 một phần, không cứu được font thiếu ToUnicode. |
| Hướng đúng? | Giữ pdf.js + **quality gate lúc ingest** (F1) + **post-process layout** (F2) + **repair âm tiết mở rộng** (F4/F5). Tùy chọn OCR cho trang không có text layer. |

---

## 2. Bảng thư viện (đã kiểm chứng trên npm registry, 2026-09-22)

### 2a. PDF engine chạy browser

| Package | Version / ngày | License | Browser? | Nhận xét |
|---|---|---|---|---|
| `pdfjs-dist` (đang dùng) | 6.3.289 | Apache-2.0 | ✅ WASM/worker | Engine hiện tại. `getTextContent()` cho transform/width/height từng item. |
| `mupdf` (official, Artifex) | 1.28.1 · 2026-09-05 | **AGPL-3.0-or-later** | ✅ WASM (ESM) | Engine mạnh hơn pdf.js; có `StructuredText`/toJSON. Rủi ro license lớn. |
| `mupdf-js` (cộng đồng) | 2.0.1 · 2024-06 | AGPL-3.0 | ✅ WASM | **Đã ngừng** — v2 là stub lỗi, tác giả khuyên chuyển sang `mupdf`. Bỏ qua. |
| `unpdf` | 1.8.1 · 2026-02 | MIT | ⚠️ Node ≥22 (unjs) | Chỉ là wrapper `pdfjs-dist`, **không phải engine mới**. Vô ích cho F1–F3. |
| `tesseract.js` | 7.0.0 · 2025-12 | Apache-2.0 | ✅ WASM + worker | **OCR** — cứu được trang không có ToUnicode (F1). Có `vie.traineddata` (đã xác nhận tồn tại, >5MB). Nặng, cần tải model. |

### 2b. NLP / xử lý tiếng Việt

| Package | Version / ngày | License | Browser? | Nội dung / liên quan |
|---|---|---|---|---|
| `vntk` | 1.4.4 · 2020-04 | MIT | ❌ | Toolkit NLP VN (word-tokenizer, POS, NER), nhưng phụ thuộc native `crfsuite` + `fasttext`. **Không chạy browser**, stale 6 năm. |
| `@f97/vntk` | 1.4.6 · 2022-08 | MIT | ❌ | Fork `vntk`, cùng vấn đề native. |
| `@vntk/dictionary` | 1.0.0 · 2017 | MIT | ⚠️ data-only | Từ điển âm tiết VN — dùng làm data được, code thì cũ. |
| `dongdu` | 0.9.4 · 2016 | MIT | ❌ | Node addon word-segment (C++). Bỏ. |
| `vitokenizer` | 1.0.0 · 2026-02 | **GPL-3.0** | ✅ JS (script tag/ESM, ~700KB) | Gần câu hỏi nhất: ghép âm tiết thành từ cho full-text search (bù `Intl.Segmenter`). **Không sửa split/mất khoảng trắng (F4/F5)**, và GPL-3.0 độc hại. Repo `femtost/vitokenizer` (1 star). |
| `dictionary-vi` | 3.0.0 · 2023-11 | **GPL-2.0** | ⚠️ data | Từ điển chính tả Hunspell tiếng Việt (wooorm). Ghép `nspell` → phát hiện/ sửa `dư ới`→`dưới`. License GPL. |
| `vietnamese-conversion` | 2.0.0 · 2025-03 | MIT | ✅ | Chuyển mã Unicode ↔ VNI ↔ TCVN3 ↔ VIQR. Chỉ hữu ích nếu font nguồn là legacy encoding (không phải ca F1 hiện tại). |
| `vietnamese-unicode-toolkit` | 0.0.4 · 2020 | MIT | ✅ | Tổ hợp/ tách dấu Unicode. Nhỏ, cũ. |
| `@polyglot-bundles/vi-lang` | 0.5.4 · 2026-09 | MIT | ✅ | Bảng ký tự/ âm/ IPA — **data** để tự validate âm tiết hợp lệ. |

> Tham chiếu ngoài browser (không dùng được ở đây, chỉ để so sánh chất lượng): `underthesea`, `pyvi`, `VnCoreNLP` (Python) — tốt nhất cho word-seg tiếng Việt nhưng cần server.

---

## 3. Đối chiếu từng khuyết điểm → thư viện nào giúp được

| Lỗi | Bản chất | Lib giải được? | Ghi chú |
|---|---|---|---|
| **F1** mojibake (font thiếu ToUnicode) | Font/encoding | ❌ Không engine text nào. Chỉ `tesseract.js` (OCR) hoặc **loại trang**. | pdf.js trả raw glyph code khi không có ToUnicode. MuPDF có thêm fallback tên glyph (`/Differences`, built-in encoding) → **đôi khi** đọc được nhiều hơn, nhưng không đảm bảo. |
| **F2** footnote dính số Điều | Layout (superscript) | ❌ Không có lib sẵn. | Phải tự post-process: superscript = `height` nhỏ hơn + baseline (`transform[5]`) cao hơn dòng. pdf.js **đã cấp** `height`/`transform`, chỉ thiếu logic tách. |
| **F3** heading giữa dòng | Chunking | ❌ | Thuần logic `chunker.ts`, không lib. |
| **F4** tách âm tiết (`dư ới`) | Tiếng Việt | ⚠️ `dictionary-vi`+`nspell` (GPL), hoặc tự viết bảng âm tiết từ `@polyglot-bundles/vi-lang`. | Đây chính là "repair" hiện có nhưng quá hẹp (`text-normalize.ts:29`). Không lib browser nào làm sẵn. |
| **F5** mất khoảng trắng (`lợiích`) | Tiếng Việt + geometry | ⚠️ Như F4. | Cần sửa `joinTextItems` (guard mark-aware, `pdf.ts:141`) + validator âm tiết. |
| **F6** verdict `contradicted`/`unsupported` | LLM (Jev) | ❌ | Ngoài phạm vi thư viện text. |

---

## 4. Phân tích các ứng viên đáng cân nhắc

**MuPDF (`mupdf` 1.28.1).** Engine text-extraction đầy đủ hơn pdf.js (structured text, đọc cả `StructuredText` có nhãn khối/ block/ line). Về F2, nó trả thêm thông tin layout nên dễ tách superscript hơn — nhưng vẫn phải tự code. Rào cản: **AGPL-3.0-or-later** (phải mua commercial license nếu không tuân thủ AGPL) và bundle WASM lớn hơn. Không đảm bảo cứu F1 vì cùng phụ thuộc ToUnicode.

**Tesseract.js + `vie`.** Cách duy nhất thật sự lấy được text từ trang **không có text layer**. Apache-2.0, chạy WASM trong browser. Nhược: cần tải `vie.traineddata` (>5MB, đã xác nhận tồn tại ở `naptha/tessdata/4.0.0_best/`), chậm, chỉ nên chạy cho **trang bị nghi** sau quality gate, không OCR cả tài liệu.

**`vitokenizer` (GPL-3.0).** Đúng chủ đề "tokenize tiếng Việt" nhưng sai mục tiêu: nó ghép âm tiết thành từ cho **full-text search**, không sửa khoảng trắng hỏng trong text đã ingest. Cộng thêm GPL-3.0 và repo 1-star → không khuyến nghị.

**`dictionary-vi` + `nspell` (GPL-2.0).** Có thể dùng làm spell-check để sửa split: nếu `dư ới` không có trong từ điển nhưng `dưới` có → ghép lại. Khả thi về kỹ thuật nhưng GPL-2.0 và cần bộ máy Hunspell; với phạm vi hẹp F4/F5, tự viết bảng âm tiết (data từ `@polyglot-bundles/vi-lang`, MIT) rẻ hơn.

**Không ứng viên nào** cho F2/F3: superscript-footnote và chunking theo Điều là logic đặc thù pháp luật VN, hệ JS/WASM không có lib.

---

## 5. Khuyến nghị (ưu tiên giảm dần)

1. **Không thay PDF engine.** Giữ `pdfjs-dist`; đầu tư vào ingest-time quality gate (F1) và post-process layout (F2) — đòn rẻ hơn, tác động đúng lỗi.
2. **Quality gate lúc ingest (F1):** đếm tỷ lệ ký tự phi-Việt/ không phải chữ trên mỗi block; nếu vượt ngưỡng → loại hoặc gắn cờ "không có text layer". Không để mojibake vào index.
3. **OCR theo nhu cầu (F1):** chỉ khi block bị gắn cờ, tùy chọn chạy `tesseract.js` (`lang: 'vie'`) render trang → text. Giữ sau feature-flag để không phình bundle mặc định.
4. **Repair âm tiết VN (F4/F5):** mở rộng `normalizeVietnameseSyllableSplits` hiện có + thêm bước validate bằng bảng âm tiết hợp lệ (tự build, dùng data MIT của `@polyglot-bundles/vi-lang`), thay vì kéo lib GPL.
5. **Tách footnote superscript (F2):** dùng `height`/`transform[5]` đã có trong item pdf.js để phát hiện superscript, tách số khỏi tiêu đề Điều. Không cần lib.
6. **Chỉ cân nhắc `mupdf`** nếu (a) chấp nhận AGPL/ mua license, và (b) benchmark thực tế trên 5 PDF của corpus cho thấy giảm F1/F2 rõ rệt. Nếu chỉ "có thể tốt hơn" thì không đáng.

---

## 6. Nguồn đã fetch (bằng chứng)

- npm registry metadata: `vntk`, `@f97/vntk`, `dongdu`, `vitokenizer`, `vietnamese-conversion`, `dictionary-vi`, `vietnamese-unicode-toolkit`, `@polyglot-bundles/vi-lang`, `mupdf`, `mupdf-js`, `unpdf`, `tesseract.js`
- https://www.npmjs.com/package/mupdf (Artifex, AGPL, browser support)
- https://github.com/andytango/mupdf-js (deprecated → official `mupdf`)
- https://github.com/femtost/vitokenizer (GPL-3.0, FTS tokenizer)
- https://github.com/naptha/tessdata/tree/gh-pages/4.0.0_best (`vie.traineddata.gz` tồn tại)
- Code hiện tại: `src/rag/pdf.ts`, `src/rag/text-normalize.ts`, `src/rag/chunker.ts`, `src/rag/ingest.ts`

**Độ tin cậy:** metadata version/license ngày fetch là chắc chắn; đánh giá "MuPDF có thể đọc tốt hơn pdf.js khi thiếu ToUnicode" là **suy luận** chưa benchmark trên corpus này — cần đo nếu muốn kết luận.
