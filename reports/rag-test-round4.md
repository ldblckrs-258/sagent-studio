# RAG Harness — Round 4 (black-box)

**Ngày:** 2026-09-22 · **Phạm vi:** 5 tài liệu PDF (1.244 chunk) trong thư viện cục bộ
**Phương pháp:** chạy trực tiếp các tool `list_documents` / `search_documents` / `get_chunk` /
`get_neighbors` / `verify_citation` trên corpus thật, đối chiếu với đọc source
(`pdf.ts`, `text-normalize.ts`, `chunker.ts`) để quy nguyên nhân. Không sửa code.

---

## 1. Kết luận nhanh

| Nhóm chức năng | Kết quả |
|---|---|
| Định tuyến + taxonomy lý do (`ok`, `skipped`, `no_relevant`, `premise_conflict`) | ✅ đủ, phân biệt được |
| Tách `conflicting` khi premise sai | ✅ |
| Dedup chunk trùng lặp | ✅ (20 quét → 8 trả về) |
| `verify_citation` 4 verdict | ✅ tất cả đều tới được và phân biệt rõ |
| Access control (`get_chunk` id lạ) | ✅ `not_found` |
| `get_neighbors` scoping theo tài liệu | ✅ |
| **Chất lượng văn bản đã ingest** | ❌ còn nhiều lỗi nặng (mục 3) |

> **Rủi ro cao nhất:** một khối **mojibake** (text rác do font không Unicode) đã vào corpus và
> được trả về nguyên vẹn như một passage — xem F1.

---

## 2. Ma trận test — những gì đã đạt

| # | Truy vấn / hành động | Kỳ vọng | Quan sát |
|---|---|---|---|
| T1 | `search_documents("Ngày Pháp luật Việt Nam là ngày nào…")` | `ok` | ✅ `ok`, 1 passage, `candidatesScanned: 5` |
| T2 | `search_documents("Cách nấu phở bò ngon tại nhà")` | off-topic → `skipped` | ✅ `skipped`, `passages: []`, scanned 0 |
| T3 | `search_documents("…văn bản hợp nhất")` | không liên quan → `no_relevant` | ✅ `no_relevant`, scanned 5 |
| T4 | `search_documents("Vì sao Ngày Pháp luật… vào ngày 2 tháng 9?")` | premise sai → `premise_conflict` | ✅ `premise_conflict`, `passages: []`, `conflicting: [1]` |
| T5 | `search_documents("Quốc hội")` `topK: 20` | dedup co danh sách | ✅ scanned 20 → **8** passage |
| T6 | `search_documents("…Thủ tướng Chính phủ")` | `ok` | ✅ |
| T7 | `verify_citation(quote nguyên văn)` | `verified`, span, `auto` | ✅ score 1, span, `auto: true` |
| T8 | `verify_citation(claim diễn giải)` | `verified` | ✅ conf 1, `auto: true` |
| T9 | `verify_citation("…tổ chức vào ngày 2 tháng 9")` | `contradicted` | ✅ `contradicted`, conf 1, `auto: true` |
| T10 | `verify_citation("Thủ đô nước Pháp là Paris")` | `unsupported` | ✅ `unsupported`, conf `null`, `auto: false`, score 0.29 |
| T11 | `verify_citation("…bị xử phạt 10 triệu đồng")` | `fabricated` | ✅ `fabricated`, conf 0.99, `auto: false` |
| T12 | `get_chunk("invented-chunk-id")` | từ chối | ✅ `not_found` |
| T13 | `get_neighbors(radius 1 và 3)` | chỉ trong cùng tài liệu | ✅ mọi neighbor cùng `docTitle`; đọc được sau đó |
| T14 | `verify_citation` chéo tài liệu (`52-vbhn-vpqh`) | `verified` | ✅ score 1 |

Không thấy telemetry rò rỉ: kết quả `search_documents` chỉ có `query/reason/passages/
conflicting/injectionWithheld/candidatesScanned/untrustedNotice` — **không** có score, rank,
tên provider/model. ✅

---

## 3. Khiếm khuyết phát hiện (kèm bằng chứng)

### F1 — [NẶNG] Khối mojibake lọt vào corpus và được trả về như passage

Tài liệu `52-vbhn-vpqh`, chunk `e4ff29e8-40cf-4d66-80ef-f4e46d0ac146` (ordinal 28) chứa một
đoạn hoàn toàn vô nghĩa — dấu hiệu trang PDF dùng font **không có bảng mã ToUnicode**:

```
…ho(lc lam đc;li biiu' ., ' H9i dong nhan don tie hinh thanh H(Ji dong
nhan dan lam thai iJ cac phuang ' 1 'dang th(1'C hi¢nn10hinh chinh quyen
i16 thi kh6ng t6 chu·c H(Jit16ng nhan dan.". VAN PHONG QUOC HQI , So: …
chu'C danh Chu tich, Pho Chu tich, Truong cac Ban cua' , , ,,
```

Đoạn này **được trả về thẳng cho model** trong kết quả `search_documents("Điều 110 quy định
về đơn vị hành chính")`. Đây là text rác: không thể đọc, không thể trích dẫn, chỉ tốn token và
có thể làm nhiễu embedding/ranking. Cần một **bộ lọc chất lượng lúc ingest** (tỷ lệ ký tự
"lạ"/không phải chữ Việt, tỷ lệ token vô nghĩa) để loại hoặc gắn cờ trang không có lớp text.

### F2 — [NẶNG] Số footnote dính vào số hiệu Điều, làm sai định danh điều luật

Trong `52-vbhn-vpqh` (bản hợp nhất Hiến pháp có footnote), chỉ số footnote bị nối thẳng vào
tiêu đề điều:

| Trong corpus | Đúng phải là |
|---|---|
| `Điều 1104` (xuất hiện 2 lần) | `Điều 110` + footnote `4` |
| `Điều 1115` | `Điều 111` + footnote `5` |
| `1.3 Chủ tịch nước…` | `1.` + footnote `3` |

Hệ quả với một RAG pháp luật: truy vấn "Điều 110" và passage trả về ghi "Điều 1104" — **định
danh điều luật bị sai**, và model có thể trích dẫn nhầm số điều. `TRAILING_PAGE_NUMBER` chỉ xử
lý số trang sau dấu câu, không xử lý superscript footnote giữa câu.

### F3 — [TRUNG BÌNH] Chunk mở/kết thúc giữa câu, nhiều điều bị gộp

Passage `5d203d5e…` mở đầu bằng `" tỉnh, thành phố trực\nthuộc trung ương…"` (giữa câu) và gộp
liền Điều 96 → 97 → 98 trong một khối. Nguyên nhân (đọc `chunker.ts`): `LEGAL_HEADING` neo
đầu dòng (`^\s*(Điều|…)`), nhưng trong file thật tiêu đề nằm **giữa dòng**:

```
…thực hiện nhiệm vụ, quyền\nhạn của mình. Điều 97\nNhiệm kỳ của Chính phủ…
```

`"Điều 97"` không ở đầu dòng ⇒ không tách ⇒ các điều dính làm một. **F4 (chunking theo Điều)
đã code nhưng vô hiệu trên corpus này.** Có cả tiêu đề lặp trong cùng chunk (`Điều 95` hai
lần, `Điều 1104` hai lần) — tàn dư của bản hợp nhất.

### F4 — [TRUNG BÌNH] Tách âm tiết vẫn tồn tại trong text đã lưu

`normalizeVietnameseSyllableSplits` bỏ sót các mảnh *nguyên âm + coda/nguyên âm* (đây là hạn
chế **cố ý**, ghi rõ trong comment code: "`nư ớc` is left alone"). Kết quả trên corpus:

- `dư ới` (dưới), `nư ớc` (nước), `c ủa` (của), `đi ều` (điều), `b ản` (bản)

Vì vector được sinh từ chính text này, **retrieval đang xếp hạng trên token hỏng**; sửa matcher
không sửa được index.

### F5 — [TRUNG BÌNH] Dính chữ (mất khoảng trắng) trước âm tiết bắt đầu bằng nguyên âm

Xuất hiện đều: `lợiích` (lợi ích), `cóý nghĩa`, `vớiý`, `lấyý kiến`, `choý chí`, `tựý thức`,
`vàoý thức`, `vàý nghĩa`. Cơ chế khả nghi: trong `joinTextItems`, guard
`!startsWithCombiningMark(str)` chặn thêm dấu cách khi item kế bắt đầu bằng dấu tổ hợp, khiến
âm tiết sau bị dán vào từ trước. Đây là mặt trái của fix NFC/mark-aware — cần kiểm tra lại.

### F6 — [THẤP] Claim lạc đề bị gán `contradicted` thay vì `unsupported`

`verify_citation("Ngày Pháp luật… là dịp để ăn mừng chiến thắng bóng đá")` → `contradicted`
(conf 0.55, `auto: false`). Passage không hề nói về bóng đá; đúng ra là `unsupported`. Tin tốt:
`auto: false` nên không bị auto-accept. Nhưng ranh giới `contradicted`/`unsupported` chưa ổn
định (so sánh: "Thủ đô Pháp là Paris" lại ra `unsupported` chuẩn).

---

## 4. Vì sao các verdict citation vẫn "chạy đúng" dù text hỏng

Repair ở tầng matcher che một phần lỗi ingest (defense-in-depth): một claim **sạch**
`"…địa giới hành chính dưới tỉnh…"` vẫn `verified` (score 1, conf 0.92, `auto: true`) chống
lại passage có `"dư ới"`. Tốt cho trải nghiệm, **nhưng che luôn khuyết điểm dữ liệu**: một
trích dẫn có thể verify sạch trên passage mà text lưu trữ vẫn không dùng được để đọc. Nên
quyết định dứt khoát: repair ở **ingest** (dữ liệu + vector sạch) hay chỉ ở **matcher**.

---

## 5. Khuyến nghị (ưu tiên giảm dần)

1. **Lọc chất lượng lúc ingest (F1):** phát hiện trang/khối có tỷ lệ ký tự phi-Việt cao →
   loại hoặc đánh dấu "không có lớp text"; đừng để mojibake vào index.
2. **Xử lý footnote (F2):** tách superscript khỏi tiêu đề (`Điều 1104` → `Điều 110`), hoặc
   chuẩn hoá số Điều bằng regex + đối chiếu danh mục điều hợp lệ.
3. **Chunking theo Điều (F3):** cho `LEGAL_HEADING` khớp cả khi "Điều/Chương" đứng giữa dòng
   sau dấu câu, không chỉ đầu dòng.
4. **Mở rộng repair âm tiết (F4):** cân nhắc thêm mẫu nguyên-âm + (nguyên-âm|coda) một cách
   thận trọng, đo lại tỷ lệ "over-join" trên `Bộ trưởng`, `đã ra`, `và em`.
5. **Rà guard mark-aware (F5):** kiểm tra lại `startsWithCombiningMark` để không nuốt khoảng
   trắng thật.
6. **Re-ingest toàn bộ corpus** sau khi sửa, rồi chạy lại bộ test này (kiểm tra chunk id/boundary
   thực sự thay đổi — như Round 3 từng bị chặn).
7. **Siết phân loại `contradicted`/`unsupported` (F6):** claim passage "im lặng" nên về
   `unsupported`.

---

## 6. Phụ lục — bằng chứng thô

- **`ok` + dedup:** `Quốc hội`, `candidatesScanned: 20` → 8 passage.
- **`premise_conflict`:** truy vấn "ngày 2 tháng 9" → `passages: []`, `conflicting` chứa passage
  nói "Ngày 09 tháng 11".
- **`skipped`:** "Cách nấu phở bò ngon tại nhà" → scanned 0.
- **`no_relevant`:** "…văn bản hợp nhất", "Lưu bản nháp tự động…" → scanned 5, 0 passage.
- **`verified` nguyên văn:** `Ngày 09 tháng 11 hằng năm là Ngày Pháp luật nước Cộng hòa xã hội
  chủ nghĩa Việt Nam.` → score 1 + span + `auto: true`.
- **`fabricated`:** "…không tham gia Ngày Pháp luật sẽ bị xử phạt 10 triệu đồng" → conf 0.99,
  `auto: false`.
- **Mojibake:** chunk `e4ff29e8-40cf-4d66-80ef-f4e46d0ac146` (mục F1).
- **Footnote dính:** "Điều 1104", "Điều 1115", "1.3" trong `49af8db1`, `427a5d32`.
