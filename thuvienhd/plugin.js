(function () {
    // ─────────────────────────────────────────────────────────────────────────────
    // ThuVienHD – SkyStream Plugin  (QuickJS compatible – no DOMParser)
    // Configure Fshare via ⚙️ Domains: set URL to
    //   https://thuvienhd.top?fshare=your_email@gmail.com:your_password
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

    // ── Regex HTML helpers ────────────────────────────────────────────────────────
    function decodeHtmlEntities(s) {
        return (s || "")
            .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
            .replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&nbsp;/g, " ")
            .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n)));
    }
    function stripTags(s) { return (s || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(); }
    function metaContent(html, property) {
        const re = new RegExp('<meta[^>]+(?:property|name)\\s*=\\s*["\']' + property + '["\'][^>]*content\\s*=\\s*["\']([^"\']*)["\']', 'i');
        const re2 = new RegExp('<meta[^>]+content\\s*=\\s*["\']([^"\']*)["\'][^>]*(?:property|name)\\s*=\\s*["\']' + property + '["\']', 'i');
        const m = re.exec(html) || re2.exec(html);
        return m ? decodeHtmlEntities(m[1]) : null;
    }
    function imgSrc(tag) {
        const tryAttr = name => { const m = new RegExp(name + '\\s*=\\s*["\']([^"\']+)["\']', 'i').exec(tag); return m && !m[1].startsWith("data:") ? m[1] : null; };
        return tryAttr("data-src") || tryAttr("data-lazy-src") || tryAttr("src");
    }
    function firstHref(html) { const m = /href\s*=\s*["']([^"']+)["']/i.exec(html); return m ? m[1] : null; }
    function findLinks(html, hrefContains) {
        const links = [];
        const re = /<a\s[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
        let m;
        while ((m = re.exec(html)) !== null) {
            if (!hrefContains || m[1].includes(hrefContains))
                links.push({ href: m[1], text: stripTags(m[2]).trim(), full: m[0] });
        }
        return links;
    }

    // Parse article listing items
    function parseListingItems(html) {
        const items = [];
        const blockRe = /<article[^>]*>([\s\S]*?)<\/article>/gi;
        let m;
        while ((m = blockRe.exec(html)) !== null) {
            const block = m[1];
            // Title & href from h3 a or a[title]
            let title = null, href = null;
            const h3M = /<h3[^>]*>[\s\S]*?<a[^>]+href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i.exec(block);
            if (h3M) { href = h3M[1]; title = stripTags(h3M[2]).trim(); }
            if (!title) {
                const aM = /<a[^>]+(?:href\s*=\s*["']([^"']+)["'][^>]+title\s*=\s*["']([^"']+)["']|title\s*=\s*["']([^"']+)["'][^>]+href\s*=\s*["']([^"']+)["'])/i.exec(block);
                if (aM) { href = aM[1] || aM[4]; title = decodeHtmlEntities(aM[2] || aM[3]); }
            }
            if (!title || !href) continue;
            title = decodeHtmlEntities(title);
            const imgM = /<img([^>]+)>/i.exec(block);
            const poster = imgM ? imgSrc(imgM[0]) : null;
            const yearM = /\b(19|20)\d{2}\b/.exec(block);
            items.push(new MultimediaItem({ title, url: href, posterUrl: poster, type: "movie", year: yearM ? parseInt(yearM[0]) : null }));
        }
        return items;
    }

    function parseFshareLinks(html) {
        return findLinks(html, "fshare.vn").map(l => l.href).filter(Boolean).filter((v, i, a) => a.indexOf(v) === i);
    }

    // ── Fshare API ────────────────────────────────────────────────────────────────
    async function fshareLogin(force = false) {
        if (!force && _fshareToken && _fshareSession) return true;
        parseFshareCredentials();
        if (!_fshareEmail || !_fsharePass) return false;
        try {
            const resp = JSON.parse(await httpPost(FSHARE_LOGIN_API, JSON.stringify({ app_key: FSHARE_APP_KEY, user_email: _fshareEmail, password: _fsharePass })));
            if (resp.token && resp.session_id) { _fshareToken = resp.token; _fshareSession = resp.session_id; return true; }
            return false;
        } catch (_) { return false; }
    }
    async function fshareGetLink(linkCode) {
        if (!await fshareLogin()) return null;
        const fileUrl = `https://www.fshare.vn/file/${linkCode}?share=8805984`;
        const body = JSON.stringify({ zipflag: 0, url: fileUrl, password: "", token: _fshareToken });
        try {
            let resp = JSON.parse(await httpPost(FSHARE_DOWNLOAD_API, body, { Cookie: `session_id=${_fshareSession}` }));
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
    function cleanTitle(t) { return t.replace(/\(\d{4}\)/g, "").replace(/(vietsub|thuyết minh|lồng tiếng|full hd|4k|bluray|hdrip|[–—])/gi, " ").replace(/\s+/g, " ").trim(); }
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
                        const d = JSON.parse(await httpGet(`${TMDB_BASE}/search/${type}?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(q)}${yr}&language=${lang}`));
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
                const d = JSON.parse(await httpGet(`${TMDB_BASE}/${type}/${id}?api_key=${TMDB_API_KEY}&language=${lang}&append_to_response=credits,recommendations,images&include_image_language=vi,en,null`));
                if (d.overview || lang === "en-US") return d;
            } catch (_) { }
        }
        return null;
    }

    // ── Categories ────────────────────────────────────────────────────────────────
    const CATEGORIES = [
        ["Trending", "/trending/page/"],
        ["Phim Mới", "/recent/page/"],
        ["Phim Lẻ", "/genre/phim-le/page/"],
        ["Phim Bộ", "/genre/series/page/"],
        ["Thuyết Minh", "/genre/thuyet-minh-tieng-viet/page/"],
        ["Lồng Tiếng", "/genre/long-tieng-tieng-viet/page/"],
        ["Hành Động", "/genre/action/page/"],
        ["Kinh Dị", "/genre/horror/page/"],
        ["Hài", "/genre/comedy/page/"],
        ["Viễn Tưởng", "/genre/sci-fi/page/"],
        ["Lãng Mạn", "/genre/romance/page/"],
        ["Hoạt Hình", "/genre/animation/page/"],
        ["Hình Sự", "/genre/crime/page/"],
        ["Hàn Quốc", "/genre/korean/page/"],
        ["Trung Quốc", "/genre/trung-quoc-series/page/"],
        ["4K", "/genre/4k/page/"],
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
            const html = await httpGet(`${getSiteBase()}/?s=${encodeURIComponent(query)}`);
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

            const title = stripTags((/<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html) || [])[1] || "") || metaContent(html, "og:title");
            if (!title) return cb({ success: false, errorCode: "NOT_FOUND", message: "Không tìm thấy tiêu đề" });

            const poster = metaContent(html, "og:image")
                || (() => { const m = /<div[^>]*class\s*=\s*["'][^"']*poster[^"']*["'][^>]*>[\s\S]*?<img([^>]+)>/i.exec(html); return m ? imgSrc(m[0]) : null; })();
            const description = metaContent(html, "og:description")
                || stripTags((/<div[^>]*class\s*=\s*["'][^"']*wp-content[^"']*["'][^>]*>([\s\S]*?)<\/div>/i.exec(html) || [])[1] || "");
            const yearM = /\b(19|20)\d{2}\b/.exec(title + " " + html.substring(0, 5000));
            const year = yearM ? parseInt(yearM[0]) : null;
            const tags = [];
            const genreRe = /<a[^>]+href\s*=\s*["'][^"']*\/genre\/[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi;
            let gm;
            while ((gm = genreRe.exec(html)) !== null) { const t = stripTags(gm[1]).trim(); if (t) tags.push(t); }

            // Fshare links — parse ThuVienHD table format
            const fshareEntries = [];
            // Table row format: <a class="face-button" href="fshare.vn/...">
            const tableRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
            let tRow;
            while ((tRow = tableRe.exec(html)) !== null) {
                const row = tRow[1];
                const aM = /<a[^>]+href\s*=\s*["']([^"']*fshare\.vn[^"']*)["'][^>]*>/i.exec(row);
                if (!aM) continue;
                const fshareUrl = aM[1];
                const nameM = /<span[^>]*>([\s\S]*?)<\/span>/i.exec(row);
                const sizeM = /\b([\d.,]+)\s*(GB|MB|KB|TB)\b/i.exec(row);
                const fileName = nameM ? stripTags(nameM[1]).trim() : fshareUrl.split("/").pop();
                const fileSize = sizeM ? `${sizeM[1]} ${sizeM[2]}` : "";
                if (!fshareEntries.some(e => e.url === fshareUrl))
                    fshareEntries.push({ url: fshareUrl, fileName, fileSize });
            }
            // Fallback: plain links
            if (fshareEntries.length === 0) {
                parseFshareLinks(html).forEach(fUrl => {
                    fshareEntries.push({ url: fUrl, fileName: fUrl.split("/").pop(), fileSize: "" });
                });
            }
            // Check download page
            if (fshareEntries.length === 0) {
                const dlM = /href\s*=\s*["']([^"']*\/download\?id=[^"']*)["']/i.exec(html);
                if (dlM) {
                    try {
                        const dlUrl = dlM[1].startsWith("http") ? dlM[1] : `${getSiteBase()}${dlM[1]}`;
                        const dlHtml = await httpGet(dlUrl, { Referer: url });
                        parseFshareLinks(dlHtml).forEach(fUrl => {
                            if (!fshareEntries.some(e => e.url === fUrl))
                                fshareEntries.push({ url: fUrl, fileName: fUrl.split("/").pop(), fileSize: "" });
                        });
                    } catch (_) { }
                }
            }

            const fshareLinks = fshareEntries.map(e => e.url);
            const hasFolderLinks = fshareLinks.some(l => l.includes("/folder/"));
            const isSeries = hasFolderLinks || fshareLinks.length > 1
                || tags.some(t => t.toLowerCase().includes("phim bộ") || t.toLowerCase().includes("series"))
                || /<(?:div|ul)[^>]*class\s*=\s*["'][^"']*episodios[^"']*["']/i.test(html);

            // TMDB enrichment
            let tmdbPoster = null, tmdbBanner = null, tmdbPlot = null;
            let tmdbActors = null, tmdbTags = null, tmdbRecs = null, tmdbYear = null, tmdbScore = null;
            try {
                const tmdb = await searchTmdb(title, year, isSeries);
                if (tmdb) {
                    const d = await getTmdbDetails(tmdb.id, tmdb.type);
                    if (d) {
                        const viP = d.images && d.images.posters && d.images.posters.find(p => p.iso_639_1 === "vi");
                        const viB = d.images && d.images.backdrops && d.images.backdrops.find(p => p.iso_639_1 === "vi");
                        tmdbPoster = tmdbImg(viP ? viP.file_path : d.poster_path, "w500");
                        tmdbBanner = tmdbImg(viB ? viB.file_path : d.backdrop_path, "original");
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
                                return new MultimediaItem({ title: rTitle, type: "movie", url: `${getSiteBase()}/?s=${encodeURIComponent(rTitle)}`, posterUrl: tmdbImg(r.poster_path, "w220_and_h330_face") });
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

            function getQuality(name) {
                if (!name) return null;
                const n = name.toLowerCase();
                if (n.includes("2160") || n.includes("4k")) return "4K";
                if (n.includes("1080")) return "1080p";
                if (n.includes("720")) return "720p";
                return null;
            }

            if (isSeries) {
                const episodes = [];
                const epHasSection = /<(?:div|ul)[^>]*class\s*=\s*["'][^"']*episodios[^"']*["']/i.test(html);
                if (epHasSection) {
                    const epSection = (/<(?:div|ul)[^>]*class\s*=\s*["'][^"']*episodios[^"']*["'][^>]*>([\s\S]*?)<\/(?:div|ul)>/i.exec(html) || [])[1] || "";
                    const epRe = /<a[^>]+href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
                    let em, idx = 0;
                    while ((em = epRe.exec(epSection)) !== null && idx < 500) {
                        episodes.push(new Episode({ name: stripTags(em[2]).trim() || `Tập ${idx + 1}`, url: em[1], season: 1, episode: ++idx }));
                    }
                }
                if (episodes.length === 0) {
                    const folderLinks = fshareLinks.filter(l => l.includes("/folder/"));
                    const fileEntries = fshareEntries.filter(e => !e.url.includes("/folder/"));
                    let si = 1;
                    for (const rootFolder of folderLinks) {
                        try {
                            const items = await fshareFolderList(rootFolder);
                            if (!items) { episodes.push(new Episode({ name: `📁 Phần ${si}`, season: si++, episode: 1, url: rootFolder, posterUrl: finalPoster })); continue; }
                            const subs = items.filter(i => i.isFolder);
                            const files = items.filter(i => !i.isFolder);
                            if (subs.length > 0) {
                                const sfR = await Promise.all(subs.map(async (sf, sfi) => ({ sfi, sf, files: await fshareFolderList(sf.url).catch(() => null) })));
                                sfR.sort((a, b) => a.sfi - b.sfi).forEach(({ sf, files: subFiles }) => {
                                    const sNum = si++;
                                    (subFiles || []).filter(f => !f.isFolder).sort((a, b) => a.name.localeCompare(b.name)).forEach((f, i) => {
                                        episodes.push(new Episode({ name: f.name, season: sNum, episode: i + 1, url: `${f.url}|||${f.sizeStr}|||${f.name}`, description: `(${f.sizeStr}) - ${f.name}`, posterUrl: finalPoster, quality: getQuality(f.name) }));
                                    });
                                    if (!subFiles || !subFiles.length) episodes.push(new Episode({ name: `📁 ${sf.name}`, season: sNum, episode: 1, url: sf.url, posterUrl: finalPoster }));
                                });
                                files.sort((a, b) => a.name.localeCompare(b.name)).forEach((f, i) => {
                                    episodes.push(new Episode({ name: f.name, season: si, episode: i + 1, url: `${f.url}|||${f.sizeStr}|||${f.name}`, description: `(${f.sizeStr}) - ${f.name}`, posterUrl: finalPoster, quality: getQuality(f.name) }));
                                });
                                if (files.length) si++;
                            } else {
                                files.sort((a, b) => a.name.localeCompare(b.name)).forEach((f, i) => {
                                    episodes.push(new Episode({ name: f.name, season: si, episode: i + 1, url: `${f.url}|||${f.sizeStr}|||${f.name}`, description: `(${f.sizeStr}) - ${f.name}`, posterUrl: finalPoster, quality: getQuality(f.name) }));
                                });
                                si++;
                            }
                        } catch (_) { episodes.push(new Episode({ name: `📁 Phần ${si}`, season: si++, episode: 1, url: rootFolder, posterUrl: finalPoster })); }
                    }
                    fileEntries.forEach((entry, idx) => {
                        episodes.push(new Episode({ name: entry.fileName, season: folderLinks.length ? si : 1, episode: idx + 1, url: `${entry.url}|||${entry.fileSize}|||${entry.fileName}`, description: entry.fileSize ? `(${entry.fileSize}) - ${entry.fileName}` : entry.fileName, posterUrl: finalPoster, quality: getQuality(entry.fileName) }));
                    });
                }
                cb({ success: true, data: new MultimediaItem({ title, url, type: "series", posterUrl: finalPoster, bannerUrl: finalBanner, description: finalPlot, year: finalYear, score: tmdbScore, tags: finalTags, cast: finalActors, recommendations: finalRecs, episodes }) });
            } else {
                const fshareRefs = fshareEntries.map(e => ({ url: e.url, name: e.fileName }));
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
