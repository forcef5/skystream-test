(function () {
    // ─────────────────────────────────────────────────────────────────────────────
    // ThuVienCine – SkyStream Plugin  (QuickJS compatible – no DOMParser)
    // Configure Fshare via ⚙️ Domains: set URL to
    //   https://thuviencine.com?fshare=your_email@gmail.com:your_password
    // ─────────────────────────────────────────────────────────────────────────────

    const FSHARE_LOGIN_API = "https://api.fshare.vn/api/user/login";
    const FSHARE_DOWNLOAD_API = "https://api.fshare.vn/api/session/download";
    const FSHARE_FOLDER_API = "https://api.fshare.vn/api/fileops/getFolderList";
    const FSHARE_APP_KEY = "dMnqMMZMUnN5YpvKENaEhdQQ5jxDqddt";
    const FSHARE_USER_AGENT = "kodivietmediaf-K58W6U";
    const TMDB_API_KEY = "7ddf38e999a838273590dffbc2980189";
    const TMDB_BASE = "https://api.themoviedb.org/3";
    const TMDB_IMG = "https://image.tmdb.org/t/p";

    let _fshareToken = null, _fshareSession = null;
    let _fshareEmail = null, _fsharePass = null;

    // ── URL helpers ──────────────────────────────────────────────────────────────
    function parseFshareCredentials() {
        try {
            const url = manifest.baseUrl;
            const idx = url.indexOf("?fshare=");
            if (idx === -1) return;
            const creds = decodeURIComponent(url.substring(idx + 8));
            const colon = creds.indexOf(":");
            if (colon === -1) return;
            _fshareEmail = creds.substring(0, colon);
            _fsharePass = creds.substring(colon + 1);
        } catch (_) { }
    }
    function getSiteBase() {
        const url = manifest.baseUrl;
        const idx = url.indexOf("?");
        return idx === -1 ? url : url.substring(0, idx);
    }

    // ── HTTP ─────────────────────────────────────────────────────────────────────
    async function httpGet(url, headers = {}) {
        const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", ...headers } });
        return await r.text();
    }
    async function httpPost(url, body, headers = {}) {
        const r = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json", "User-Agent": FSHARE_USER_AGENT, ...headers },
            body: typeof body === "string" ? body : JSON.stringify(body)
        });
        return await r.text();
    }

    // ── Regex HTML parser (replaces DOMParser) ───────────────────────────────────
    function decodeHtmlEntities(s) {
        return (s || "")
            .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
            .replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&nbsp;/g, " ")
            .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n)));
    }
    function stripTags(s) { return (s || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(); }

    // Get attribute value from an HTML tag string
    function attr(tag, name) {
        const re = new RegExp(name + '\\s*=\\s*(?:"([^"]*)"|\\'([^\\']*)\\' | ([^\\s >] *))', 'i');
        const m = re.exec(tag);
        return m ? decodeHtmlEntities(m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3]) : null;
    }
    // Get inner text/html of the first matching tag
    function innerOf(html, selector) {
        // selector is a simple tag name or "tag.class" or "tag[attrname]"
        let tag = selector.replace(/[.\[#].*/, "");
        const re = new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)<\\/' + tag + '>', 'i');
        const m = re.exec(html);
        return m ? m[1] : "";
    }
    // Extract all occurrences of a tag (returns array of {tag, inner})
    function findAll(html, tagName) {
        const re = new RegExp('<(' + tagName + ')([^>]*)>([\\s\\S]*?)<\\/' + tagName + '>', 'gi');
        const results = [];
        let m;
        while ((m = re.exec(html)) !== null) {
            results.push({ full: m[0], attrs: m[2], inner: m[3] });
        }
        return results;
    }
    // Get all anchor tags that match an href pattern
    function findLinks(html, hrefContains) {
        const links = [];
        const re = /<a\s[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
        let m;
        while ((m = re.exec(html)) !== null) {
            const href = m[1];
            if (!hrefContains || href.includes(hrefContains)) {
                links.push({ href, text: stripTags(m[2]).trim(), full: m[0] });
            }
        }
        return links;
    }
    // Get meta tag content
    function metaContent(html, property) {
        const re = new RegExp('<meta[^>]+(?:property|name)\\s*=\\s*["\']' + property + '["\'][^>]*content\\s*=\\s*["\']([^"\']*)["\']', 'i');
        const re2 = new RegExp('<meta[^>]+content\\s*=\\s*["\']([^"\']*)["\'][^>]*(?:property|name)\\s*=\\s*["\']' + property + '["\']', 'i');
        let m = re.exec(html) || re2.exec(html);
        return m ? decodeHtmlEntities(m[1]) : null;
    }
    // Get image src from img tag - tries data-src, data-lazy-src, src
    function imgSrc(imgTag) {
        return attr(imgTag, 'data-src') || attr(imgTag, 'data-lazy-src') || attr(imgTag, 'src');
    }
    // Find first img tag
    function firstImg(html) {
        const m = /<img([^>]+)>/i.exec(html);
        return m ? m[0] : null;
    }
    // Find first <a> href
    function firstHref(html) {
        const m = /href\s*=\s*["']([^"']+)["']/i.exec(html);
        return m ? m[1] : null;
    }
    // Get text between tags matching pattern
    function h1Text(html) {
        const m = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
        return m ? stripTags(m[1]).trim() : null;
    }

    // ── Parse movie items from a listing page ─────────────────────────────────────
    function parseListingItems(html) {
        const items = [];
        // Match article or div.item blocks
        const blockRe = /(?:<article[^>]*>([\s\S]*?)<\/article>|<div\s[^>]*class\s*=\s*["'][^"']*\bitem\b[^"']*["'][^>]*>([\s\S]*?)<\/div>)/gi;
        let m;
        while ((m = blockRe.exec(html)) !== null) {
            const block = m[1] || m[2];
            if (!block) continue;
            // Title: look for <a title="..."> or <h3><a>
            let title = null, href = null;
            const titleAttrM = /href\s*=\s*["']([^"']+)["'][^>]+title\s*=\s*["']([^"']+)["']/.exec(block)
                || /title\s*=\s*["']([^"']+)["'][^>]+href\s*=\s*["']([^"']+)["']/.exec(block);
            if (titleAttrM) {
                if (titleAttrM[0].includes("title=")) {
                    const hrefM = /href\s*=\s*["']([^"']+)["']/.exec(titleAttrM[0]);
                    const titM = /title\s*=\s*["']([^"']+)["']/.exec(titleAttrM[0]);
                    href = hrefM ? hrefM[1] : null;
                    title = titM ? decodeHtmlEntities(titM[1]) : null;
                }
            }
            if (!title) {
                const h3M = /<h3[^>]*><a[^>]+href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i.exec(block);
                if (h3M) { href = h3M[1]; title = stripTags(h3M[2]).trim(); }
            }
            if (!title) {
                const aM = /<a[^>]+href\s*=\s*["']([^"']+)["'][^>]*title\s*=\s*["']([^"']+)["']/i.exec(block)
                    || /<a[^>]+title\s*=\s*["']([^"']+)["'][^>]*href\s*=\s*["']([^"']+)["']/i.exec(block);
                if (aM) { title = decodeHtmlEntities(aM[1] || aM[2]); href = aM[2] || aM[1]; }
            }
            if (!title || !href) continue;
            title = decodeHtmlEntities(title);
            const imgTag = firstImg(block);
            const poster = imgTag ? imgSrc(imgTag) : null;
            const yearM = /\b(19|20)\d{2}\b/.exec(block);
            const year = yearM ? parseInt(yearM[0]) : null;
            const type = (href.includes("/tv-series/") || href.includes("-season-") || href.includes("-phan-")) ? "series" : "movie";
            items.push(new MultimediaItem({ title, url: href, posterUrl: poster, type, year }));
        }
        return items;
    }

    // ── Parse Fshare links from HTML ──────────────────────────────────────────────
    function parseFshareLinks(html) {
        return findLinks(html, "fshare.vn").map(l => l.href).filter(Boolean).filter((v, i, a) => a.indexOf(v) === i);
    }

    // ── Fshare API ────────────────────────────────────────────────────────────────
    async function fshareLogin(force = false) {
        if (!force && _fshareToken && _fshareSession) return true;
        parseFshareCredentials();
        if (!_fshareEmail || !_fsharePass) return false;
        try {
            const body = JSON.stringify({ app_key: FSHARE_APP_KEY, user_email: _fshareEmail, password: _fsharePass });
            const resp = JSON.parse(await httpPost(FSHARE_LOGIN_API, body));
            if (resp.token && resp.session_id) { _fshareToken = resp.token; _fshareSession = resp.session_id; return true; }
            return false;
        } catch (_) { return false; }
    }
    async function fshareGetLink(linkCode) {
        if (!await fshareLogin()) return null;
        const fileUrl = `https://www.fshare.vn/file/${linkCode}?share=8805984`;
        const body = JSON.stringify({ zipflag: 0, url: fileUrl, password: "", token: _fshareToken });
        const hdrs = { Cookie: `session_id=${_fshareSession}` };
        try {
            let resp = JSON.parse(await httpPost(FSHARE_DOWNLOAD_API, body, hdrs));
            if (!resp.location && resp.code === 201) {
                _fshareToken = null; _fshareSession = null;
                if (!await fshareLogin()) return null;
                const b2 = JSON.stringify({ zipflag: 0, url: fileUrl, password: "", token: _fshareToken });
                resp = JSON.parse(await httpPost(FSHARE_DOWNLOAD_API, b2, { Cookie: `session_id=${_fshareSession}` }));
            }
            return resp.location || null;
        } catch (_) { return null; }
    }
    async function fshareFolderList(folderUrl) {
        if (!await fshareLogin()) return null;
        const body = JSON.stringify({ token: _fshareToken, url: folderUrl, dirOnly: 0, pageIndex: 0, limit: 10000 });
        try {
            const items = JSON.parse(await httpPost(FSHARE_FOLDER_API, body, { Cookie: `session_id=${_fshareSession}` }));
            return items.map(item => {
                const isFolder = item.type === "0";
                const url = isFolder ? `https://www.fshare.vn/folder/${item.linkcode}` : `https://www.fshare.vn/file/${item.linkcode}`;
                const gb = item.size / (1024 * 1024 * 1024);
                const sizeStr = gb >= 1 ? `${gb.toFixed(1)} GB` : `${(item.size / (1024 * 1024)).toFixed(0)} MB`;
                return { name: item.name, linkcode: item.linkcode, size: item.size, sizeStr, isFolder, url };
            }).sort((a, b) => a.name.localeCompare(b.name));
        } catch (_) { return null; }
    }

    // ── TMDB ─────────────────────────────────────────────────────────────────────
    function tmdbImg(path, size) { return path ? `${TMDB_IMG}/${size || "w500"}${path}` : null; }
    function cleanTitle(t) {
        return t.replace(/\(\d{4}\)/g, "")
            .replace(/(vietsub|thuyết minh|lồng tiếng|full hd|4k|bluray|hdrip|camrip|fshare|phần \d+|season \d+|[–—])/gi, " ")
            .replace(/\s+/g, " ").trim();
    }
    async function searchTmdb(title, year, isSeries) {
        const parts = title.split(/\s*[–—]\s*/);
        const queries = parts.length >= 2 ? [parts[1], parts[0], title] : [title, cleanTitle(title)];
        const types = isSeries ? ["tv", "movie"] : ["movie", "tv"];
        for (const type of types) {
            for (const q of queries) {
                if (!q || q.length < 2) continue;
                for (const lang of ["vi-VN", "en-US"]) {
                    try {
                        const yr = year ? `&year=${year}` : "";
                        const url = `${TMDB_BASE}/search/${type}?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(q)}${yr}&language=${lang}`;
                        const d = JSON.parse(await httpGet(url));
                        if (d.results && d.results.length > 0) return { id: d.results[0].id, type };
                    } catch (_) { }
                }
            }
        }
        return null;
    }
    async function getTmdbDetails(id, type) {
        for (const lang of ["vi-VN", "en-US"]) {
            try {
                const url = `${TMDB_BASE}/${type}/${id}?api_key=${TMDB_API_KEY}&language=${lang}&append_to_response=credits,recommendations,images&include_image_language=vi,en,null`;
                const d = JSON.parse(await httpGet(url));
                if (d.overview || lang === "en-US") return d;
            } catch (_) { }
        }
        return null;
    }

    // ── Categories ────────────────────────────────────────────────────────────────
    const CATEGORIES = [
        ["Trending", "/top/page/"],
        ["Phim Lẻ", "/movies/page/"],
        ["Phim Bộ", "/tv-series/page/"],
        ["Kids", "/kids/page/"],
        ["Hành Động", "/phim-hanh-dong/page/"],
        ["Kinh Dị", "/phim-kinh-di/page/"],
        ["Hài", "/phim-hai/page/"],
        ["Viễn Tưởng", "/phim-khoa-hoc-vien-tuong/page/"],
        ["Lãng Mạn", "/phim-lang-man/page/"],
        ["Hoạt Hình", "/phim-hoat-hinh/page/"],
        ["Bí Ẩn", "/phim-bi-an/page/"],
        ["Gia Đình", "/phim-gia-dinh/page/"],
        ["Chiến Tranh", "/phim-chien-tranh/page/"],
        ["Tài Liệu", "/phim-tai-lieu/page/"],
        ["Lịch Sử", "/phim-lich-su/page/"],
    ];

    // ── getHome ───────────────────────────────────────────────────────────────────
    async function getHome(cb) {
        try {
            const base = getSiteBase();
            const data = {};
            await Promise.all(CATEGORIES.map(async ([name, path]) => {
                try {
                    const html = await httpGet(`${base}${path}1`);
                    const items = parseListingItems(html);
                    if (items.length > 0) data[name] = items;
                } catch (_) { }
            }));
            if (Object.keys(data).length === 0)
                return cb({ success: false, errorCode: "NOT_FOUND", message: "Không tải được trang chủ" });
            cb({ success: true, data });
        } catch (e) {
            cb({ success: false, errorCode: "PARSE_ERROR", message: String(e) });
        }
    }

    // ── search ────────────────────────────────────────────────────────────────────
    async function search(query, page, cb) {
        try {
            const base = getSiteBase();
            const html = await httpGet(`${base}/?s=${encodeURIComponent(query)}`);
            const items = parseListingItems(html);
            cb({ success: true, data: items });
        } catch (e) {
            cb({ success: false, errorCode: "SEARCH_ERROR", message: String(e) });
        }
    }

    // ── load ──────────────────────────────────────────────────────────────────────
    async function load(url, cb) {
        try {
            const html = await httpGet(url, { Referer: getSiteBase() });

            // Title
            const title = stripTags(
                (/<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html) || [])[1] || ""
            ) || metaContent(html, "og:title");
            if (!title) return cb({ success: false, errorCode: "NOT_FOUND", message: "Không tìm thấy tiêu đề" });

            // Poster
            const poster = metaContent(html, "og:image")
                || (() => { const m = /<div[^>]*class\s*=\s*["'][^"']*poster[^"']*["'][^>]*>[\s\S]*?<img([^>]+)>/i.exec(html); return m ? imgSrc(m[0]) : null; })();

            // Description
            const description = metaContent(html, "og:description")
                || stripTags((/<div[^>]*class\s*=\s*["'][^"']*trama[^"']*["'][^>]*>([\s\S]*?)<\/div>/i.exec(html) || [])[1] || "").trim();

            // Year
            const yearM = /\b(19|20)\d{2}\b/.exec(title + " " + html.substring(0, 5000));
            const year = yearM ? parseInt(yearM[0]) : null;

            // Tags
            const tags = [];
            const genreRe = /<a[^>]+href\s*=\s*["'][^"']*(?:genre|the-loai|category)[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi;
            let gm;
            while ((gm = genreRe.exec(html)) !== null) { const t = stripTags(gm[1]).trim(); if (t) tags.push(t); }

            // Fshare links
            let fshareLinks = parseFshareLinks(html);
            // Check download page
            if (fshareLinks.length === 0) {
                const dlM = /href\s*=\s*["']([^"']*\/download\?id=[^"']*)["']/i.exec(html);
                if (dlM) {
                    try {
                        const dlUrl = dlM[1].startsWith("http") ? dlM[1] : `${getSiteBase()}${dlM[1]}`;
                        const dlHtml = await httpGet(dlUrl, { Referer: url });
                        fshareLinks = parseFshareLinks(dlHtml);
                    } catch (_) { }
                }
            }

            const hasFolderLinks = fshareLinks.some(l => l.includes("/folder/"));
            const isSeries = url.includes("/tv-series/") || hasFolderLinks || fshareLinks.length > 1
                || /<div[^>]*class\s*=\s*["'][^"']*episodios[^"']*["']/i.test(html)
                || tags.some(t => t.toLowerCase().includes("phim bộ"));

            // TMDB enrichment
            let tmdbPoster = null, tmdbBanner = null, tmdbPlot = null;
            let tmdbActors = null, tmdbTags = null, tmdbRecs = null, tmdbYear = null, tmdbScore = null;
            try {
                const tmdb = await searchTmdb(title, year, isSeries);
                if (tmdb) {
                    const d = await getTmdbDetails(tmdb.id, tmdb.type);
                    if (d) {
                        const viPoster = d.images && d.images.posters && d.images.posters.find(p => p.iso_639_1 === "vi");
                        const viBackdrop = d.images && d.images.backdrops && d.images.backdrops.find(p => p.iso_639_1 === "vi");
                        tmdbPoster = tmdbImg(viPoster ? viPoster.file_path : d.poster_path, "w500");
                        tmdbBanner = tmdbImg(viBackdrop ? viBackdrop.file_path : d.backdrop_path, "original");
                        tmdbPlot = d.overview || null;
                        tmdbScore = d.vote_average ? Math.round(d.vote_average * 10) / 10 : null;
                        tmdbYear = parseInt((d.release_date || d.first_air_date || "").slice(0, 4)) || null;
                        tmdbTags = d.genres ? d.genres.map(g => g.name) : null;
                        tmdbActors = d.credits && d.credits.cast
                            ? d.credits.cast.slice(0, 10).map(m => new Actor({ name: m.name, role: m.character, image: tmdbImg(m.profile_path, "w185") }))
                            : null;
                        tmdbRecs = d.recommendations && d.recommendations.results
                            ? d.recommendations.results.slice(0, 10).map(r => {
                                const rTitle = r.title || r.name;
                                if (!rTitle) return null;
                                return new MultimediaItem({
                                    title: rTitle, type: "movie",
                                    url: `${getSiteBase()}/?s=${encodeURIComponent(rTitle)}`,
                                    posterUrl: tmdbImg(r.poster_path, "w220_and_h330_face")
                                });
                            }).filter(Boolean)
                            : null;
                    }
                }
            } catch (_) { }

            const finalPoster = tmdbPoster || poster || "";
            const finalBanner = tmdbBanner || finalPoster;
            const finalPlot = tmdbPlot || description;
            const finalTags = (tmdbTags && tmdbTags.length) ? tmdbTags : tags;
            const finalActors = (tmdbActors && tmdbActors.length) ? tmdbActors : [];
            const finalRecs = (tmdbRecs && tmdbRecs.length) ? tmdbRecs : [];
            const finalYear = tmdbYear || year;

            if (isSeries) {
                const episodes = [];
                // Inline episode list
                const epRe = /<li[^>]*>[\s\S]*?<a\s[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
                const hasEpList = /<(?:div|ul)[^>]*class\s*=\s*["'][^"']*episodios[^"']*["']/i.test(html);
                if (hasEpList) {
                    const epSection = (/<(?:div|ul)[^>]*class\s*=\s*["'][^"']*episodios[^"']*["'][^>]*>([\s\S]*?)<\/(?:div|ul)>/i.exec(html) || [])[1] || "";
                    let em, idx = 0;
                    while ((em = epRe.exec(epSection)) !== null) {
                        const epTitle = stripTags(em[2]).trim() || `Tập ${idx + 1}`;
                        episodes.push(new Episode({ name: epTitle, url: em[1], season: 1, episode: ++idx }));
                    }
                }
                if (episodes.length === 0) {
                    const folderLinks = fshareLinks.filter(l => l.includes("/folder/"));
                    const fileLinks = fshareLinks.filter(l => !l.includes("/folder/"));
                    let seasonIndex = 1;
                    for (const rootFolder of folderLinks) {
                        try {
                            const items = await fshareFolderList(rootFolder);
                            if (!items) { episodes.push(new Episode({ name: `📁 Phần ${seasonIndex}`, season: seasonIndex, episode: 1, url: rootFolder, posterUrl: finalPoster })); seasonIndex++; continue; }
                            const subFolders = items.filter(i => i.isFolder);
                            const rootFiles = items.filter(i => !i.isFolder);
                            if (subFolders.length > 0) {
                                const sfResults = await Promise.all(subFolders.map(async (sf, si) => {
                                    const files = await fshareFolderList(sf.url).catch(() => null);
                                    return { si, sf, files: files ? files.filter(f => !f.isFolder) : [] };
                                }));
                                sfResults.sort((a, b) => a.si - b.si).forEach(({ sf, files }) => {
                                    const sNum = seasonIndex++;
                                    (files || []).sort((a, b) => a.name.localeCompare(b.name)).forEach((file, idx) => {
                                        episodes.push(new Episode({ name: file.name, season: sNum, episode: idx + 1, url: `${file.url}|||${file.sizeStr}|||${file.name}`, description: `(${file.sizeStr}) - ${file.name}`, posterUrl: finalPoster }));
                                    });
                                    if (!files || !files.length) episodes.push(new Episode({ name: `📁 ${sf.name}`, season: sNum, episode: 1, url: sf.url, posterUrl: finalPoster }));
                                });
                                rootFiles.sort((a, b) => a.name.localeCompare(b.name)).forEach((file, idx) => {
                                    episodes.push(new Episode({ name: file.name, season: seasonIndex, episode: idx + 1, url: `${file.url}|||${file.sizeStr}|||${file.name}`, description: `(${file.sizeStr}) - ${file.name}`, posterUrl: finalPoster }));
                                });
                                if (rootFiles.length) seasonIndex++;
                            } else {
                                rootFiles.sort((a, b) => a.name.localeCompare(b.name)).forEach((file, idx) => {
                                    episodes.push(new Episode({ name: file.name, season: seasonIndex, episode: idx + 1, url: `${file.url}|||${file.sizeStr}|||${file.name}`, description: `(${file.sizeStr}) - ${file.name}`, posterUrl: finalPoster }));
                                });
                                seasonIndex++;
                            }
                        } catch (_) { episodes.push(new Episode({ name: `📁 Phần ${seasonIndex}`, season: seasonIndex++, episode: 1, url: rootFolder, posterUrl: finalPoster })); }
                    }
                    fileLinks.forEach((link, idx) => {
                        episodes.push(new Episode({ name: `Link ${idx + 1}`, season: folderLinks.length ? seasonIndex : 1, episode: idx + 1, url: link, posterUrl: finalPoster }));
                    });
                }
                cb({ success: true, data: new MultimediaItem({ title, url, type: "series", posterUrl: finalPoster, bannerUrl: finalBanner, description: finalPlot, year: finalYear, score: tmdbScore, tags: finalTags, cast: finalActors, recommendations: finalRecs, episodes }) });
            } else {
                const fshareRefs = fshareLinks.map((fl, i) => ({ url: fl, name: `Link ${i + 1} - ${fl.split("/").pop()}` }));
                const dataUrl = fshareRefs.length > 0 ? `__FSHARE__${JSON.stringify(fshareRefs)}` : url;
                cb({ success: true, data: new MultimediaItem({ title, url: dataUrl, type: "movie", posterUrl: finalPoster, bannerUrl: finalBanner, description: finalPlot, year: finalYear, score: tmdbScore, tags: finalTags, cast: finalActors, recommendations: finalRecs }) });
            }
        } catch (e) {
            cb({ success: false, errorCode: "LOAD_ERROR", message: String(e) });
        }
    }

    // ── loadStreams ───────────────────────────────────────────────────────────────
    function getQuality(name) {
        if (!name) return null;
        const n = name.toLowerCase();
        if (n.includes("2160") || n.includes("4k")) return "4K";
        if (n.includes("1080")) return "1080p";
        if (n.includes("720")) return "720p";
        if (n.includes("480")) return "480p";
        return null;
    }
    async function loadStreams(url, cb) {
        try {
            const streams = [];
            if (url.includes("|||")) {
                const parts = url.split("|||");
                const fUrl = parts[0], sizeStr = parts[1] || "", fileName = parts[2] || "";
                if (fUrl.includes("/folder/")) {
                    const files = await fshareFolderList(fUrl);
                    if (files) await Promise.all(files.filter(f => !f.isFolder).map(async file => {
                        const direct = await fshareGetLink(file.linkcode);
                        if (direct) streams.push(new StreamResult({ url: direct, source: `(${file.sizeStr}) ${file.name}`, quality: getQuality(file.name), headers: { Referer: "https://www.fshare.vn/" } }));
                    }));
                } else {
                    const linkCode = fUrl.split("/").pop().split("?")[0];
                    const direct = await fshareGetLink(linkCode);
                    if (direct) streams.push(new StreamResult({ url: direct, source: sizeStr && fileName ? `(${sizeStr}) ${fileName}` : (fileName || linkCode), quality: getQuality(fileName || fUrl), headers: { Referer: "https://www.fshare.vn/" } }));
                }
            } else if (url.startsWith("__FSHARE__")) {
                const refs = JSON.parse(url.slice("__FSHARE__".length));
                await Promise.all(refs.map(async ({ url: fUrl, name }) => {
                    const linkCode = fUrl.split("/").pop().split("?")[0];
                    const direct = await fshareGetLink(linkCode);
                    if (direct) streams.push(new StreamResult({ url: direct, source: name || linkCode, quality: getQuality(name || fUrl), headers: { Referer: "https://www.fshare.vn/" } }));
                }));
            } else if (url.includes("fshare.vn")) {
                const linkCode = url.split("/").pop().split("?")[0];
                const direct = await fshareGetLink(linkCode);
                if (direct) streams.push(new StreamResult({ url: direct, source: "Fshare Direct", headers: { Referer: "https://www.fshare.vn/" } }));
            } else {
                const html = await httpGet(url, { Referer: getSiteBase() });
                const links = parseFshareLinks(html);
                await Promise.all(links.map(async (fUrl, idx) => {
                    const linkCode = fUrl.split("/").pop().split("?")[0];
                    const direct = await fshareGetLink(linkCode);
                    if (direct) streams.push(new StreamResult({ url: direct, source: `Stream ${idx + 1}`, headers: { Referer: "https://www.fshare.vn/" } }));
                }));
            }
            if (streams.length === 0)
                return cb({ success: false, errorCode: "NOT_FOUND", message: "Không tìm thấy stream. Kiểm tra tài khoản Fshare VIP trong ⚙️ Domains." });
            cb({ success: true, data: streams });
        } catch (e) {
            cb({ success: false, errorCode: "STREAM_ERROR", message: String(e) });
        }
    }

    globalThis.getHome = getHome;
    globalThis.search = search;
    globalThis.load = load;
    globalThis.loadStreams = loadStreams;
})();
