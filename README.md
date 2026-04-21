# SkyStream Vietnamese Plugins

Các plugin SkyStream cho phim Việt Nam, được chuyển đổi từ CloudStream 3.

## Plugins

| Plugin | Website | Nội dung |
|--------|---------|---------|
| **ThuVienCine** | thuviencine.com | Phim lẻ, phim bộ, phim hoạt hình |
| **ThuVienHD** | thuvienhd.top | Phim HD, 4K, 3D, thuyết minh/lồng tiếng |

> ⚠️ **Yêu cầu tài khoản Fshare VIP** để phát video.

---

## Cài đặt nhanh

1. Mở SkyStream → **Extensions** → **Add Source**
2. Dán URL `repo.json` của repo này vào (sau khi đã deploy lên GitHub)
3. Cài plugin **ThuVienCine** hoặc **ThuVienHD**

---

## Cấu hình Fshare VIP

Mỗi plugin sử dụng Fshare API để lấy link tải trực tiếp. Bạn cần nhập thông tin đăng nhập:

1. Trong SkyStream, vào **Extensions** → tìm plugin → nhấn **⚙️ (Settings)**
2. Chọn **Domains** → chọn mục **"▶ Cấu hình Fshare"**
3. **Sửa URL** thành dạng:
   ```
   https://thuviencine.com?fshare=your_email@gmail.com:your_password
   ```
4. Lưu lại

> **Lưu ý:** Thông tin đăng nhập chỉ tồn tại trong session. Khi khởi động lại app, bạn cần chọn lại domain có thông tin.

---

## Tính năng

- ✅ **Trang chủ** với nhiều danh mục (Trending, Phim Lẻ, Phim Bộ, thể loại...)
- ✅ **Tìm kiếm** phim theo tên
- ✅ **Chi tiết phim** với metadata từ TMDB (poster, banner, mô tả, diễn viên, đánh giá)
- ✅ **Phim bộ** hỗ trợ danh sách tập, phân mùa từ Fshare Folder
- ✅ **Phim lẻ** hỗ trợ nhiều file (multi-quality)
- ✅ **TMDB enrichment** tự động: poster chất lượng cao, nội dung tiếng Việt, đề xuất phim

---

## Deploy lên GitHub (để dùng với SkyStream)

```bash
cd skystream-vietnamese-plugins
git init
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git
git add .
git commit -m "Add ThuVienCine and ThuVienHD plugins"
git push -u origin main
```

Sau đó thêm repo vào SkyStream bằng URL:
```
https://raw.githubusercontent.com/YOUR_USERNAME/YOUR_REPO/main/repo.json
```

---

## Cấu trúc thư mục

```
skystream-vietnamese-plugins/
├── repo.json                  ← Repository manifest
├── thuviencine/
│   ├── plugin.json            ← Plugin metadata & mirrors
│   └── plugin.js              ← Scraper logic
└── thuvienhd/
    ├── plugin.json
    └── plugin.js
```

---

## Kỹ thuật

- **Ngôn ngữ:** JavaScript (SkyStream Gen 2 runtime)
- **Fshare API:** Login + Download + FolderList
- **TMDB API:** Search + Details (vi-VN / en-US fallback)
- **HTML Parsing:** DOMParser
