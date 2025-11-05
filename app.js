(() => {
  const els = {
    fileInput: document.getElementById('fileInput'),
    urlInput: document.getElementById('urlInput'),
    loadUrlBtn: document.getElementById('loadUrlBtn'),
    voiceSelect: document.getElementById('voiceSelect'),
    rate: document.getElementById('rate'),
    pitch: document.getElementById('pitch'),
    volume: document.getElementById('volume'),
    rateValue: document.getElementById('rateValue'),
    pitchValue: document.getElementById('pitchValue'),
    volumeValue: document.getElementById('volumeValue'),
    playBtn: document.getElementById('playBtn'),
    pauseBtn: document.getElementById('pauseBtn'),
    resumeBtn: document.getElementById('resumeBtn'),
    stopBtn: document.getElementById('stopBtn'),
    textContainer: document.getElementById('textContainer'),
    chapterSelect: document.getElementById('chapterSelect'),
    status: document.getElementById('status'),
    resumePrompt: document.getElementById('resumePrompt'),
    resumeStartBtn: document.getElementById('resumeStartBtn'),
    restartStartBtn: document.getElementById('restartStartBtn'),
    fileList: document.getElementById('fileList'),
    refreshListBtn: document.getElementById('refreshListBtn'),
    loadAllBtn: document.getElementById('loadAllBtn')
  };

  const state = {
    fileName: null,
    text: '',
    sentences: [],
    currentIndex: 0,
    chapters: [],
    voices: [],
    voice: null,
    rate: 1.0, pitch: 1.0, volume: 1.0,
    playing: false,
    speakingLock: false,
    // 新增：同源与本地列表初始化，避免未定义
    sameOriginFiles: [],
    localFiles: [],
    chapterRanges: [],
    currentChapterIndex: 0,
    autoChapterAdvance: true,
    autoPlayOnLoad: true
  };

  const progressKey = () => state.fileName ? `reader-progress:${state.fileName}` : null;

  function setStatus(msg) { els.status.textContent = `状态：${msg}`; }
  function enableControls(loaded) {
    els.playBtn.disabled = !loaded;
    els.pauseBtn.disabled = !loaded;
    els.resumeBtn.disabled = !loaded;
    els.stopBtn.disabled = !loaded;
    els.chapterSelect.disabled = !loaded;
  }

  function populateVoices(preferZh = true) {
    const all = window.speechSynthesis.getVoices() || [];
    const zhVoices = all.filter(v => /^zh/i.test(v.lang));
    state.voices = zhVoices.length && preferZh ? zhVoices : all;
    els.voiceSelect.innerHTML = '';
    state.voices.forEach((v, i) => {
      const opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = `${v.name} (${v.lang})${v.default ? ' - 默认' : ''}`;
      els.voiceSelect.appendChild(opt);
    });
    const idxZh = state.voices.findIndex(v => /^zh/i.test(v.lang));
    const idx = idxZh >= 0 ? idxZh : 0;
    els.voiceSelect.value = String(Math.max(idx, 0));
    state.voice = state.voices[Math.max(idx, 0)] || null;
  }
  function registerVoicesReady() {
    populateVoices(true);
    window.speechSynthesis.onvoiceschanged = () => populateVoices(true);
  }

  // 智能解码：优先无替换符的结果，兼容 gb18030/gbk/big5/utf-16
  // 升级：智能解码，兼容 gb18030/gbk/big5/utf-16，并按评分选择最优
  function decodeBuffer(buf) {
    const u8 = new Uint8Array(buf);
    const bomEncoding = (() => {
      if (u8[0] === 0xEF && u8[1] === 0xBB && u8[2] === 0xBF) return 'utf-8';
      if (u8[0] === 0xFF && u8[1] === 0xFE) return 'utf-16le';
      if (u8[0] === 0xFE && u8[1] === 0xFF) return 'utf-16be';
      return null;
    })();
    const tryDecode = (label) => { try { return new TextDecoder(label).decode(buf); } catch { return null; } };
    const score = (s) => {
      if (!s) return -Infinity;
      const bad = (s.match(/\uFFFD/g) || []).length;
      const han = (s.match(/[\u4E00-\u9FFF]/g) || []).length;
      const punct = (s.match(/[。！？；：、，—…“”‘’]/g) || []).length;
      return han * 2 + punct - bad * 5;
    };
    if (bomEncoding) {
      const byBom = tryDecode(bomEncoding);
      if (byBom) return byBom;
    }
    const candidates = [
      tryDecode('utf-8'),
      tryDecode('gb18030'),
      tryDecode('gbk'),
      tryDecode('big5'),
      tryDecode('utf-16le'),
      tryDecode('utf-16be'),
      new TextDecoder().decode(buf)
    ];
    const utf8 = candidates[0];
    if (utf8 && !utf8.includes('\uFFFD')) return utf8;
    let best = candidates[0], bestScore = score(candidates[0]);
    for (let i = 1; i < candidates.length; i++) {
      const s = candidates[i], sc = score(s);
      if (sc > bestScore) { best = s; bestScore = sc; }
    }
    return best || new TextDecoder().decode(buf);
  }

  async function decodeFile(file) {
    const buf = await file.arrayBuffer();
    return decodeBuffer(buf);
  }

  function splitSentencesWithPos(text) {
    const normalized = text.replace(/\r/g, '');
    const re = /([。！？!?；;：:]+[”’"]?|…{2,}|\n{2,})/g;
    const out = [];
    let last = 0, m;
    while ((m = re.exec(normalized)) !== null) {
      const end = m.index + m[0].length;
      const slice = normalized.slice(last, end).trim();
      if (slice) out.push({ text: slice, start: last, end });
      last = end;
    }
    const rest = normalized.slice(last).trim();
    if (rest) out.push({ text: rest, start: last, end: normalized.length });
    return out;
  }
  function extractChapters(text) {
    const lines = text.split(/\r?\n/);
    const starts = [];
    let pos = 0;
    for (let i = 0; i < lines.length; i++) {
      starts[i] = pos;
      pos += lines[i].length + 1;
    }
    const chapters = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (/^第[一二三四五六七八九十百千0-9]+章/.test(line) ||
          /^第[一二三四五六七八九十百千0-9]+节/.test(line) ||
          /^(楔子|序章|引子)/.test(line)) {
        chapters.push({ title: line, charOffset: starts[i] });
      }
    }
    if (chapters.length === 0) chapters.push({ title: '全文开始', charOffset: 0 });
    return chapters;
  }
  function mapCharOffsetToSentenceIndex(charOffset, sentences) {
    let lo = 0, hi = sentences.length - 1, ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (sentences[mid].start >= charOffset) { ans = mid; hi = mid - 1; }
      else { lo = mid + 1; }
    }
    return ans;
  }

  function renderText(sentences, currentIdx) {
    els.textContainer.innerHTML = '';
    const frag = document.createDocumentFragment();
    sentences.forEach((s, i) => {
      const span = document.createElement('span');
      span.className = 'sentence' + (i === currentIdx ? ' current' : (i < currentIdx ? ' dim' : ''));
      span.textContent = s.text;
      span.dataset.idx = String(i);
      span.addEventListener('click', () => {
        state.currentIndex = i;
        highlightCurrent();
      });
      frag.appendChild(span);
    });
    els.textContainer.appendChild(frag);
    highlightCurrent();
  }
  function highlightCurrent() {
    const nodes = els.textContainer.querySelectorAll('.sentence');
    nodes.forEach(n => n.classList.remove('current'));
    const current = els.textContainer.querySelector(`.sentence[data-idx="${state.currentIndex}"]`);
    if (current) current.classList.add('current'), current.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  function chunkSentence(text, maxLen = 220) {
    const chunks = [];
    let i = 0;
    while (i < text.length) {
      chunks.push(text.slice(i, Math.min(i + maxLen, text.length)));
      i += maxLen;
    }
    return chunks;
  }

  function saveProgress() {
    const key = progressKey();
    if (!key) return;
    const data = {
      index: state.currentIndex,
      rate: state.rate, pitch: state.pitch, volume: state.volume,
      voiceName: state.voice?.name || null,
      time: Date.now()
    };
    localStorage.setItem(key, JSON.stringify(data));
  }
  function readProgress() {
    const key = progressKey();
    if (!key) return null;
    try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
  }

  function updateUIPlaying(isPlaying) {
    state.playing = isPlaying;
    els.playBtn.disabled = !state.sentences.length || isPlaying;
    els.pauseBtn.disabled = !isPlaying;
    els.resumeBtn.disabled = !state.sentences.length || isPlaying;
    els.stopBtn.disabled = !state.sentences.length || (!isPlaying && !speechSynthesis.speaking);
    setStatus(isPlaying ? `朗读中（第 ${state.currentIndex + 1} 句）` : '就绪');
  }

  function computeChapterRanges(chapters, sentences) {
    const ranges = [];
    for (let i = 0; i < chapters.length; i++) {
      const startIdx = mapCharOffsetToSentenceIndex(chapters[i].charOffset, sentences);
      const nextStart = chapters[i + 1]?.charOffset ?? Infinity;
      const endIdx = Math.max(0, mapCharOffsetToSentenceIndex(nextStart, sentences) - 1);
      ranges.push({ start: startIdx, end: endIdx });
    }
    return ranges;
  }
  function currentChapterBySentenceIndex(si) {
    const ranges = state.chapterRanges;
    for (let i = 0; i < ranges.length; i++) {
      const r = ranges[i];
      if (si >= r.start && si <= r.end) return i;
    }
    return Math.max(0, ranges.length - 1);
  }
  function setCurrentChapter(chIdx) {
    if (chIdx < 0 || chIdx >= state.chapters.length) return;
    state.currentChapterIndex = chIdx;
    els.chapterSelect.value = String(chIdx);
  }

  function loadText(text, fileName) {
    state.fileName = fileName || '未命名.txt';
    state.text = text;
    state.sentences = splitSentencesWithPos(text);
    state.chapters = extractChapters(text);

    els.chapterSelect.innerHTML = '';
    state.chapters.forEach((c, i) => {
      const opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = c.title;
      els.chapterSelect.appendChild(opt);
    });
    els.chapterSelect.value = '0';

    const prog = readProgress();
    if (prog && typeof prog.index === 'number') {
      els.resumePrompt.hidden = false;
      els.resumeStartBtn.onclick = () => {
        els.resumePrompt.hidden = true;
        state.rate = prog.rate ?? state.rate;
        state.pitch = prog.pitch ?? state.pitch;
        state.volume = prog.volume ?? state.volume;
        els.rate.value = String(state.rate);
        els.pitch.value = String(state.pitch);
        els.volume.value = String(state.volume);
        els.rateValue.textContent = state.rate.toFixed(1);
        els.pitchValue.textContent = state.pitch.toFixed(1);
        els.volumeValue.textContent = state.volume.toFixed(1);
        const voiceIdx = state.voices.findIndex(v => v.name === prog.voiceName);
        if (voiceIdx >= 0) { els.voiceSelect.value = String(voiceIdx); state.voice = state.voices[voiceIdx]; }
        state.currentIndex = prog.index;
        renderText(state.sentences, state.currentIndex);
        enableControls(true);
        setCurrentChapter(currentChapterBySentenceIndex(state.currentIndex));
        setStatus(`已加载：${state.fileName}，恢复到第 ${state.currentIndex + 1} 句`);
        if (state.autoPlayOnLoad) { populateVoices(true); speakFrom(state.currentIndex); }
      };
      els.restartStartBtn.onclick = () => {
        els.resumePrompt.hidden = true;
        state.currentIndex = 0;
        renderText(state.sentences, state.currentIndex);
        enableControls(true);
        setCurrentChapter(currentChapterBySentenceIndex(state.currentIndex));
        setStatus(`已加载：${state.fileName}`);
        if (state.autoPlayOnLoad) { populateVoices(true); speakFrom(state.currentIndex); }
      };
    } else {
      els.resumePrompt.hidden = true;
      state.currentIndex = 0;
      renderText(state.sentences, state.currentIndex);
      enableControls(true);
      setCurrentChapter(currentChapterBySentenceIndex(state.currentIndex));
      setStatus(`已加载：${state.fileName}`);
      if (state.autoPlayOnLoad) { populateVoices(true); speakFrom(state.currentIndex); }
    }
  }

  function speakFrom(index) {
    if (!state.voices.length) populateVoices(true);
    updateUIPlaying(true);
    state.speakingLock = false;
    state.currentIndex = index;
    highlightCurrent();
    scheduleNext();
  }
  function scheduleNext() {
    if (state.speakingLock) return;
    if (state.currentIndex >= state.sentences.length) {
      updateUIPlaying(false); setStatus('朗读完成'); return;
    }
    const sentence = state.sentences[state.currentIndex].text;
    const chunks = chunkSentence(sentence);
    state.speakingLock = true;
    let chunkIdx = 0;
    const speakChunk = () => {
      if (chunkIdx >= chunks.length) {
        state.currentIndex++; saveProgress(); state.speakingLock = false; highlightCurrent();
        if (state.autoChapterAdvance) {
          const newCh = currentChapterBySentenceIndex(state.currentIndex);
          if (newCh !== state.currentChapterIndex) {
            setCurrentChapter(newCh);
            setStatus(`自动跳至下一章：${state.chapters[newCh]?.title || ''}`);
          }
        }
        scheduleNext(); return;
      }
      const u = new SpeechSynthesisUtterance(chunks[chunkIdx]);
      u.voice = state.voice || null; u.rate = state.rate; u.pitch = state.pitch; u.volume = state.volume;
      u.onend = () => { chunkIdx++; speakChunk(); };
      u.onerror = () => { chunkIdx++; speakChunk(); };
      window.speechSynthesis.speak(u);
    };
    speakChunk();
  }

  // Events
  registerVoicesReady();

  els.fileInput.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setStatus('读取文件中...');
    const text = await decodeFile(file);
    loadText(text, file.name);
  });

  // 已移除：els.fileInput.addEventListener(...) 与 els.loadUrlBtn.addEventListener(...)
  
  els.voiceSelect.addEventListener('change', () => {
    const idx = Number(els.voiceSelect.value);
    state.voice = state.voices[idx] || null;
    window.speechSynthesis.cancel();
    updateUIPlaying(false);
  });
  const bindSlider = (el, labelEl, key) => {
    el.addEventListener('input', () => {
      state[key] = Number(el.value);
      labelEl.textContent = state[key].toFixed(1);
      if (speechSynthesis.speaking) { window.speechSynthesis.cancel(); updateUIPlaying(false); }
    });
  };
  bindSlider(els.rate, els.rateValue, 'rate');
  bindSlider(els.pitch, els.pitchValue, 'pitch');
  bindSlider(els.volume, els.volumeValue, 'volume');

  els.playBtn.addEventListener('click', () => { populateVoices(true); speakFrom(state.currentIndex); });
  els.pauseBtn.addEventListener('click', () => { if (speechSynthesis.speaking) { speechSynthesis.pause(); updateUIPlaying(false); setStatus('已暂停'); } });
  els.resumeBtn.addEventListener('click', () => { speechSynthesis.resume(); updateUIPlaying(true); setStatus('继续朗读'); });
  els.stopBtn.addEventListener('click', () => { speechSynthesis.cancel(); updateUIPlaying(false); setStatus('已停止'); });

  els.chapterSelect.addEventListener('change', () => {
    const idx = Number(els.chapterSelect.value);
    const targetChar = state.chapters[idx]?.charOffset ?? 0;
    state.currentIndex = mapCharOffsetToSentenceIndex(targetChar, state.sentences);
    setCurrentChapter(idx);
    highlightCurrent();
    setStatus(`已跳转到：${state.chapters[idx]?.title || '全文开始'}`);
  });

  // ===== 远程链接加载（失败自动走 Cloudflare 代理） =====
  function fileNameFromUrl(url) {
    try {
      const u = new URL(url);
      const path = u.pathname.split('/').pop() || '远程.txt';
      return decodeURIComponent(path.split('?')[0] || path);
    } catch { return '远程.txt'; }
  }

  async function loadFromUrl(url) {
    try {
      setStatus('从网络加载中...');
      const res = await fetch(url, { mode: 'cors' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = await res.arrayBuffer();
      const text = decodeBuffer(buf);
      loadText(text, fileNameFromUrl(url));
      localStorage.setItem('reader-last-url', url);
      // 已移除：els.urlInput.value = url
      return;
    } catch (e) {
      console.warn('直链加载失败，尝试通过 Cloudflare 代理...', e);
    }
    try {
      setStatus('跨域受限，使用代理加载中...');
      const proxyUrl = `/proxy?url=${encodeURIComponent(url)}`;
      const res = await fetch(proxyUrl);
      if (!res.ok) throw new Error(`Proxy HTTP ${res.status}`);
      const buf = await res.arrayBuffer();
      const text = decodeBuffer(buf);
      loadText(text, fileNameFromUrl(url));
      localStorage.setItem('reader-last-url', url);
      els.urlInput.value = url;
    } catch (e2) {
      console.error(e2);
      setStatus('加载失败：链接不可达或代理失败');
    }
  }

  els.loadUrlBtn.addEventListener('click', () => {
    const url = (els.urlInput.value || '').trim();
    if (!url) return;
    loadFromUrl(url);
  });

  (function autoLoadByParam() {
    const params = new URLSearchParams(location.search);
    const url = params.get('url') || localStorage.getItem('reader-last-url');
    if (url) { loadFromUrl(url); }
  })();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(console.warn);
  }

  // 读取站点清单并渲染列表
  async function loadManifest() {
    const sortFn = (a, b) => {
      const na = parseInt((a.match(/\d+/) || ['0'])[0], 10);
      const nb = parseInt((b.match(/\d+/) || ['0'])[0], 10);
      return (na - nb) || a.localeCompare(b);
    };
  
    let files = [];
    try {
      const res = await fetch('./files.json', { cache: 'no-cache' });
      if (res.ok) {
        files = await res.json();
      } else {
        throw new Error('manifest not found');
      }
    } catch (e) {
      console.warn('无法加载 files.json，转入同源兜底探测', e);
    }
  
    if (!Array.isArray(files) || !files.length) {
      const candidates = ['帝霸1.txt', '帝霸2.txt', '帝霸3.txt', '帝霸4.txt'];
      const found = [];
      for (const name of candidates) {
        const url = `./${encodeURIComponent(name)}`;
        try {
          const head = await fetch(url, { method: 'HEAD' });
          if (head.ok) {
            found.push(name);
            continue;
          }
        } catch {}
        try {
          const get = await fetch(url, { cache: 'no-cache' });
          if (get.ok) found.push(name);
        } catch {}
      }
      files = found;
    }
  
    state.sameOriginFiles = (files || []).filter(n => /\.txt$/i.test(n)).sort(sortFn);
    renderFileList();
    setStatus(`已加载站点列表，共 ${state.sameOriginFiles.length} 个`);
  }

  // 新增：一键加载全部同源 TXT（拼接后一次朗读）
  async function loadAllSameOrigin() {
    if (!state.sameOriginFiles.length) {
      setStatus('站点列表为空，无法加载全部');
      return;
    }
    try {
      setStatus('加载全部中...');
      const names = state.sameOriginFiles.slice();
      const urls = names.map(n => `./${encodeURIComponent(n)}`);
      const texts = [];
      for (const url of urls) {
        const res = await fetch(url, { cache: 'no-cache' });
        if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
        const buf = await res.arrayBuffer();
        texts.push(decodeBuffer(buf));
      }
      const merged = texts.map((t, i) => `【${names[i]}】\n` + t).join('\n\n');
      loadText(merged, '合集.txt');
      setStatus(`已加载合集（${names.length} 个文件）`);
    } catch (e) {
      console.error(e);
      setStatus('加载全部失败');
    }
  }

  function renderFileList() {
    if (!els.fileList) return;
    els.fileList.innerHTML = '';
    const items = state.sameOriginFiles.map(name => ({
      name,
      path: `./${encodeURIComponent(name)}`
    }));

    if (!items.length) {
      const li = document.createElement('li');
      li.className = 'list-item';
      li.textContent = '暂无可用 TXT。请在仓库根添加 files.json 或上传 TXT。';
      els.fileList.appendChild(li);
      return;
    }

    items.forEach(it => {
      const li = document.createElement('li');
      li.className = 'list-item';

      const nameEl = document.createElement('div');
      nameEl.className = 'name';
      nameEl.textContent = it.name;

      const srcEl = document.createElement('span');
      srcEl.className = 'src';
      srcEl.textContent = '站点';

      const actions = document.createElement('div');
      actions.className = 'actions';
      const openBtn = document.createElement('button');
      openBtn.className = 'btn btn-secondary';
      openBtn.textContent = '加载';
      openBtn.onclick = () => loadFromUrl(it.path);

      actions.appendChild(openBtn);
      li.appendChild(nameEl);
      li.appendChild(srcEl);
      li.appendChild(actions);
      els.fileList.appendChild(li);
    });
  }

  // 页面初始化时加载清单
  loadManifest();
  if (els.refreshListBtn) els.refreshListBtn.addEventListener('click', () => loadManifest());
  // 新增：加载全部
  if (els.loadAllBtn) els.loadAllBtn.addEventListener('click', () => loadAllSameOrigin());
  // 将本地选择的多文件加入列表
  function addLocalFiles(files) {
    Array.from(files || []).forEach(file => {
      if (/\.txt$/i.test(file.name)) {
        const exists = state.localFiles.some(f => f.name === file.name && f.file.size === file.size);
        if (!exists) state.localFiles.push({ name: file.name, file });
      }
    });
    renderFileList();
    setStatus(`已添加本地文件 ${state.localFiles.length} 个`);
  }

  // 选择本地文件：改为加入列表，不自动加载
  els.fileInput.addEventListener('change', async (e) => {
    const files = e.target.files;
    if (!files || !files.length) return;
    addLocalFiles(files);
  });

  // 刷新站点列表
  els.refreshListBtn.addEventListener('click', () => loadManifest());

  // 启动时尝试加载站点列表
  loadManifest();

  els.chapterSelect.addEventListener('change', () => {
    const idx = Number(els.chapterSelect.value);
    const targetChar = state.chapters[idx]?.charOffset ?? 0;
    state.currentIndex = mapCharOffsetToSentenceIndex(targetChar, state.sentences);
    highlightCurrent();
    setStatus(`已跳转到：${state.chapters[idx]?.title || '全文开始'}`);
  });
});