# RAG Harness — Round 5 (re-test sau khi sửa code)

**Ngày:** 2026-09-22 · **So sánh với:** Round 4
**Phương pháp:** chạy lại ma trận black-box trên corpus thật + đọc source đã thay đổi.

---

## 1. Kết luận trong một dòng

**Code đã sửa nhưng corpus CHƯA được re-ingest** → hành vi live gần như y hệt Round 4;
mọi lỗi dữ liệu (F1/F2/F4/F5) **vẫn hiện nguyên** trong kết quả trả về model. Các fix chỉ
kiểm chứng được bằng cách **xóa + thêm lại tài liệu**.

---

## 2. Code đã thay đổi gì (so Round 4)

| File | Trước | Sau | Nội dung mới |
|---|---|---|---|
| `text-normalize.ts` | 36 dòng | 102 dòng | Viết lại `normalizeVietnameseSyllableSplits` theo **ngữ pháp âm tiết** (xử lý `dư ới`, `nư ớc`, `c ủa`…); thêm `repairMissingSyllableSpaces` (nối chữ bị dính: `lợiích` → `lợi ích`) |
| `pdf.ts` | 281 | 352 | `joinTextItems` tách **footnote superscript** khỏi số Điều; thêm `isGarbledPage` lọc trang mojibake; `normalizeWhitespace` chạy repair hai chiều |
| `chunker.ts` | 223 | 238 | Thêm `MID_LINE_HEADING`: chèn ngắt dòng trước "Điều/Chương…" khi nó đứng giữa dòng sau dấu câu |
| `port.ts` | — | 490 | Thêm đường **query-rewrite cho nguồn `user`** + `query-rewrite.ts` (tool path dùng `agent`, không đổi) |
| `text-normalize.test.ts` | — | mới | Assert `dư ới→dưới`, `lợiích→lợi ích`, `và em/đã ra` giữ nguyên… |

Đây là các fix nhắm đúng vào F1–F5 của Round 4. **Thiết kế đúng**, nhưng chưa có tác dụng live.

---

## 3. Blocker: corpus không đổi

`list_documents` vẫn y nguyên Round 4 — cùng `updatedAt` và `chunkCount`:

| Tài liệu | chunkCount | updatedAt |
|---|---|---|
| luu-ban-nhap-tu-dong-4 | 355 | 1790065586672 |
| 672488 | 74 | 1790065336798 |
| 52-vbhn-vpqh | 29 | 1790065294633 |
| a6a9ee9a… | 8 | 1790065268315 |
| lich-su… | 3 | 1790065253484 |

Không có re-extract / re-embed. Vì `search_documents` đọc **text đã lưu**, các truy vấn trả về
**y hệt Round 4, từng ký tự**:

- Mojibake `e4ff29e8…` (ordinal 28) **vẫn được trả về** → F1 chưa được lọc.
- `Điều 1104`, `Điều 1115`, `1.3` **vẫn nguyên** → F2 chưa tách footnote.
- `dư ới`, `nư ớc`, `c ủa`, `đi ều` **vẫn nguyên** → F4 chưa repair trên đĩa.
- `lợiích`, `cóý nghĩa`, `lấyý kiến`, `choý chí` **vẫn nguyên** → F5 chưa nối.
- Chunk vẫn gộp nhiều Điều, mở giữa câu → F3 chưa tách.

> Nghĩa là: các fix trong `pdf.ts`/`chunker.ts` nằm trên **đường ingest**, mà ingest không chạy
> lại ⇒ chúng vô hình với corpus hiện tại.

---

## 4. Ma trận citation — Round 5 vs Round 4

Các verdict vẫn tới được và đúng. Khác biệt chính nằm ở F6 (bất định).

| Claim (trên cùng chunk) | Round 4 | Round 5 |
|---|---|---|
| Quote nguyên văn "Ngày 09 tháng 11…" | `verified` score 1 + span + auto | ✅ giống hệt |
| "…tổ chức vào ngày 2 tháng 9" | `contradicted` conf 1 auto | ✅ giống hệt |
| "Thủ đô nước Pháp là Paris" | `unsupported` conf null | ✅ giống hệt |
| "…bị xử phạt 10 triệu đồng" | `fabricated` conf 0.99 | ⚠️ run1 `unsupported` 0.99 · run2 `fabricated` 0.99 · run3 `fabricated` 0.98 |
| "…ăn mừng chiến thắng bóng đá" | `contradicted` conf 0.55 | `contradicted` conf 0.46 |
| "…địa giới hành chính **dưới** tỉnh…" (passage có `dư ới`) | `verified` score 1 conf 0.92 | `verified` score 1 conf 0.88 |

### F6 — claim bịa/bịa đặt tại ranh giới `fabricated`↔`unsupported` là **bất định**

Cùng một claim ("…xử phạt 10 triệu đồng", không có thật trong passage) cho **3 kết quả khác
nhau** trong 3 lần chạy (`unsupported`, `fabricated`, `fabricated`), conf ≈ 0.98–0.99. Cả ba đều
`auto: false` nên **không auto-accept** — an toàn cho hành vi, nhưng nghĩa là:
- nhãn `fabricated` **không ổn định** giữa các lần gọi (Jev là LLM), và
- một ca "kết quả được báo cáo" có thể lật nhãn giữa hai phiên.

Không phải lỗi nghiêm trọng (không auto-accept), nhưng nên chốt: hoặc hạ `fabricated` xuống chỉ
dùng khi có bằng chứng mạnh cố định, hoặc coi `unsupported`/`fabricated` là **một lớp "không
được nguồn ủng hộ"** ở phía UI để tránh gây nhầm lẫn "lần trước nó bảo bịa, lần này bảo không
đề cập".

---

## 5. Điểm sáng

- Repair hai chiều ở `text-normalize.ts` là cải thiện thật: một claim viết sạch vẫn `verified`
  (score 1) trên passage còn `dư ới` ở tầng matcher (defense-in-depth).
- Thiết kế fix tách bạch đúng tầng: **extract** (`pdf.ts`) lo dữ liệu vào, **match** (`jev.ts`)
  lo so khớp — chỉ còn câu hỏi chính sách "sửa ở đâu" (đã nêu Round 4).
- Unit test mới phủ đúng các ca Round 4 nêu ra.

---

## 6. Việc cần làm để nghiệm thu (không thể xác minh nếu chưa làm)

1. **Xóa + thêm lại từng PDF** (re-ingest). Sau đó `chunkCount` và `chunk id` **phải đổi**.
2. Kiểm tra lại trên corpus mới:
   - `e4ff29e8…`/passage mojibake **biến mất** (F1).
   - Số Điều không còn `1104`/`1115`; footnote tách riêng (F2).
   - Chunk bắt đầu bằng "Điều N" thay vì giữa câu; mỗi Điều một passage (F3).
   - Không còn `dư ới`, `lợiích` trong `search_documents` (F4/F5).
3. Chạy lại đúng ma trận này để so sánh.
4. (Tùy chọn) `.git diff` để xác nhận chỉ 4 file trên đổi và không rơi regression khác.

---

## 7. Trạng thái các finding Round 4

| Finding | Trạng thái Round 5 |
|---|---|
| F1 mojibake | 🟡 **Đã code**, chưa có tác dụng (chờ re-ingest) |
| F2 footnote dính số Điều | 🟡 **Đã code**, chưa có tác dụng |
| F3 gộp Điều / mở giữa câu | 🟡 **Đã code**, chưa có tác dụng |
| F4 tách âm tiết | 🟡 **Đã code** (ingest) + 🟢 matcher đã tự repair |
| F5 dính chữ | 🟡 **Đã code** (ingest); matcher chưa nối (chỉ có chiều tách) |
| F6 `fabricated`↔`unsupported` | 🔴 mới: **bất định** giữa các lần chạy |
