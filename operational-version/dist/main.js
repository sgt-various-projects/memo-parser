"use strict";
// ===== STATE =====
let columns = [];
let selected = new Set();
let dragInfo = null;
let _n = 0;
const uid = () => 'c' + _n++;
let orgOriginalContent = '';
let orgSelectedCharPos = null;
let orgSelectedRange = null;
let orgSectionCardModeActive = false;
// ===== Outline drag-to-file (振り分け) state =====
let orgFileDropActive = false;
let orgFileDropDir = null;
let orgFileDropEntries = [];
let orgFileDropSearchQuery = '';
let orgFileDropItemsContainer = null;
let orgDraggedOutlineCharPositions = null;
/** ファイル振り分け表示中の、複数選択中アウトラインの charPos（Ctrl+クリック／ラバーバンド選択で追加）。 */
let orgFileDropSelectedOutlines = new Set();
let orgDraggedSectionCard = null;
/** 「アウトライン一覧」タブ（左のアウトライン一覧のミラー表示）を表示中かどうか。 */
let orgOutline2Active = false;
/** 「アウトライン一覧」タブを離れる直前のスクロール位置（再度そのタブを開いた際に復元する）。 */
let orgOutline2ScrollTop = 0;
/** 折りたたみ中のアウトラインの charPos（左のアウトライン一覧）。 */
let orgCollapsedOutlines = new Set();
/** 折りたたみ中のアウトラインの charPos（「アウトライン一覧」タブ側、左とは独立）。 */
let orgOutline2CollapsedOutlines = new Set();
/**
 * アウトライン一覧同士の並べ替え（ドラッグ&ドロップ）用の複数選択（Ctrl+クリック／ラバーバンド選択）。
 * 左右どちらのアウトライン一覧からでも同じ集合を共有する。同じレベルのアウトラインのみ選択可能。
 */
let orgReorderSelectedOutlines = new Set();
/** アウトライン一覧の絞り込み検索文字列（左）。 */
let orgOutlineSearchQuery = '';
/** アウトライン一覧の絞り込み検索文字列（「アウトライン一覧」タブ側、左とは独立）。 */
let orgOutline2SearchQuery = '';
let colWidth = 190;
// ===== TEXT MODE STATE =====
let textRows = [];
let textSelectedIds = new Set();
let textAcTarget = null;
let textAcActiveIdx = -1;
let textDefaultOutline = '';
// ===== Auto-scroll =====
let _autoScrollRAF = null;
let _autoScrollSpeed = 0;
function _startAutoScroll(speed) {
    _autoScrollSpeed = speed;
    if (_autoScrollRAF)
        return;
    const step = () => {
        const bw = document.querySelector('.board-wrap');
        if (bw && _autoScrollSpeed !== 0) {
            bw.scrollLeft += _autoScrollSpeed;
            _autoScrollRAF = requestAnimationFrame(step);
        }
        else {
            _autoScrollRAF = null;
        }
    };
    _autoScrollRAF = requestAnimationFrame(step);
}
function _stopAutoScroll() {
    _autoScrollSpeed = 0;
    if (_autoScrollRAF) {
        cancelAnimationFrame(_autoScrollRAF);
        _autoScrollRAF = null;
    }
}
// ===== Rubber band =====
const rb = { active: false, docX0: 0, docY0: 0, lastCX: 0, lastCY: 0, lastCtrl: false };
const rbEl = document.getElementById('rubber-band');
// ===== Parsers =====
const MEMO_CODE_FENCE_MAX_LINES = 300;
/**
 * 空行で区切られたブロックの行範囲一覧を返す（``` の囲み区間内の空行は区切りとみなさない）。
 * 囲まれた本文が MEMO_CODE_FENCE_MAX_LINES 行を超える場合は囲みとみなさない
 * （``` が片側だけ書かれていた場合、遠く離れた次の ``` までが誤って1つの囲みと判定され、
 * 間の空行での分割がすべて無効化されてしまうのを防ぐため）。
 */
function splitLinesIntoBlocks(lines) {
    const fenceLineIdxs = [];
    lines.forEach((line, i) => { if (/^```/.test(line.trim()))
        fenceLineIdxs.push(i); });
    const isFenceMarker = new Array(lines.length).fill(false);
    for (let i = 0; i < fenceLineIdxs.length; i += 2) {
        const openIdx = fenceLineIdxs[i];
        const hasClose = i + 1 < fenceLineIdxs.length;
        const closeIdx = hasClose ? fenceLineIdxs[i + 1] : lines.length - 1;
        const spanLines = closeIdx - openIdx - 1;
        if (spanLines <= MEMO_CODE_FENCE_MAX_LINES) {
            isFenceMarker[openIdx] = true;
            if (hasClose)
                isFenceMarker[closeIdx] = true;
        }
    }
    const blocks = [];
    let blockStart = -1;
    let inCode = false;
    lines.forEach((line, i) => {
        if (isFenceMarker[i])
            inCode = !inCode;
        if (!inCode && line.trim() === '') {
            if (blockStart !== -1) {
                blocks.push({ start: blockStart, end: i });
                blockStart = -1;
            }
        }
        else if (blockStart === -1) {
            blockStart = i;
        }
    });
    if (blockStart !== -1)
        blocks.push({ start: blockStart, end: lines.length });
    return blocks;
}
function parseMemos(text) {
    if (!text.trim())
        return [];
    const lines = text.split('\n');
    return splitLinesIntoBlocks(lines)
        .map(b => lines.slice(b.start, b.end).join('\n').trim())
        .filter(Boolean);
}
function parseCategories(text) {
    return text.split('\n').map(l => l.trim()).filter(Boolean);
}
// ===== Export text generation =====
function generateExport(cols = columns) {
    document.querySelectorAll('.card.editing').forEach(el => el.blur());
    const sections = [];
    for (const col of cols) {
        if (col.cards.length === 0)
            continue;
        const body = col.cards.map(c => c.content).join('\n\n\n');
        sections.push('** ' + col.name + '\n' + body);
    }
    return sections.join('\n\n');
}
/** 各列の中で、内容の文字列順にカードを並び替える。 */
function guiSortByContent() {
    for (const col of columns) {
        col.cards.sort((a, b) => a.content.trim().localeCompare(b.content.trim(), 'ja'));
    }
    render();
}
/**
 * 内容が完全一致するカードを重複とみなし、1件を残して削除する対象を選び出す（列をまたいで判定）。
 * 出現順（列の並び→列内のカード順）で最初の1件を残す。
 */
function guiFindDuplicateCards() {
    const seen = new Set();
    const duplicates = [];
    const keptColumns = columns.map(col => {
        const keptCards = [];
        for (const card of col.cards) {
            const key = card.content.trim();
            if (key && seen.has(key)) {
                duplicates.push(card);
            }
            else {
                if (key)
                    seen.add(key);
                keptCards.push(card);
            }
        }
        return { ...col, cards: keptCards };
    });
    return { keptColumns, duplicates };
}
/** 重複するカード（内容が完全一致するもの。列をまたいで判定）を1件残して削除し、ファイルへ保存する。 */
async function guiApplyDedup() {
    if (!orgOriginalContent.trim()) {
        await orgModalAlert('ファイルを読み込んでください');
        return;
    }
    if (orgSelectedCharPos === null) {
        await orgModalAlert('アウトラインを選択してください');
        return;
    }
    const { keptColumns, duplicates } = guiFindDuplicateCards();
    if (duplicates.length === 0) {
        await orgModalAlert('重複するカードはありませんでした。');
        return;
    }
    const exportTextAfter = generateExport(keptColumns);
    const afterLines = exportTextAfter.split('\n').length;
    const afterNB = orgCountNonBlank(exportTextAfter);
    const dupList = duplicates.map(d => '・' + orgSummarizeContent(d.content)).join('\n');
    const confirmed = await orgModalConfirm(`内容が完全に一致するカードが${duplicates.length}件見つかりました（列をまたいで判定）。1件を残し、残りを削除します:\n\n` +
        dupList + '\n\n' +
        `削除後のExport行数: ${afterLines}行 / 空白以外: ${afterNB}行\n\n` +
        'OKを押すと重複を削除し、ファイルへ上書き保存します。');
    if (!confirmed)
        return;
    columns = keptColumns;
    selected.clear();
    render();
    const saved = await orgReplaceSelectedSectionWithExport(exportTextAfter);
    if (!saved)
        return;
    orgShowSectionForSelected();
    window.scrollTo(0, 0);
}
/** GUI編集モードの表示中の内容をクリアし、エリア自体を非表示にしてアウトライン一覧表示に戻す。 */
function guiClearAndReturnToOutline() {
    columns = [];
    selected.clear();
    render();
    hideGuiPanel();
    showOutlinePanel();
}
// ===== Board render =====
function render() {
    const board = document.getElementById('board');
    board.innerHTML = '';
    board.style.setProperty('--col-width', colWidth + 'px');
    for (const col of columns)
        board.appendChild(makeColumn(col));
    board.appendChild(makeAddColWidget());
    const allCols = board.querySelectorAll('.column');
    if (allCols.length > 0)
        allCols[allCols.length - 1].classList.add('last-col');
    updateSelBar();
}
function makeColumn(col) {
    const wrap = document.createElement('div');
    wrap.className = 'column';
    const hdr = document.createElement('div');
    hdr.className = 'column-header';
    hdr.textContent = col.name;
    hdr.contentEditable = 'true';
    hdr.spellcheck = false;
    hdr.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            hdr.blur();
        }
    });
    hdr.addEventListener('blur', () => {
        const v = hdr.textContent?.trim() ?? '';
        col.name = v || col.name;
        if (!v)
            hdr.textContent = col.name;
    });
    hdr.addEventListener('mousedown', (e) => e.stopPropagation());
    wrap.appendChild(hdr);
    const cardsEl = document.createElement('div');
    cardsEl.className = 'column-cards';
    cardsEl.dataset['col'] = col.id;
    for (const card of col.cards)
        cardsEl.appendChild(makeCard(card));
    cardsEl.addEventListener('click', (e) => {
        if (e.target === cardsEl && !dragInfo) {
            selected.clear();
            applySelection();
            updateSelBar();
        }
    });
    cardsEl.addEventListener('dragover', (e) => {
        e.preventDefault();
        cardsEl.classList.add('drag-over');
    });
    cardsEl.addEventListener('dragleave', (e) => {
        if (!cardsEl.contains(e.relatedTarget))
            cardsEl.classList.remove('drag-over');
    });
    cardsEl.addEventListener('drop', (e) => {
        e.preventDefault();
        cardsEl.classList.remove('drag-over');
        if (dragInfo)
            doMove(dragInfo.cardIds, col.id);
    });
    wrap.appendChild(cardsEl);
    return wrap;
}
function makeCard(card) {
    const el = document.createElement('div');
    el.className = 'card' + (selected.has(card.id) ? ' selected' : '');
    el.textContent = card.content;
    el.dataset['card'] = card.id;
    el.draggable = true;
    el.addEventListener('click', (e) => {
        if (el.classList.contains('editing') || dragInfo)
            return;
        e.stopPropagation();
        if (e.ctrlKey || e.metaKey) {
            selected.has(card.id) ? selected.delete(card.id) : selected.add(card.id);
        }
        else {
            const onlyThis = selected.size === 1 && selected.has(card.id);
            selected.clear();
            if (!onlyThis)
                selected.add(card.id);
        }
        applySelection();
        updateSelBar();
    });
    el.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        el.contentEditable = 'true';
        el.draggable = false;
        el.classList.add('editing');
        el.classList.remove('selected');
        selected.delete(card.id);
        applySelection();
        updateSelBar();
        el.focus();
        const range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
        window.getSelection()?.removeAllRanges();
        window.getSelection()?.addRange(range);
    });
    el.addEventListener('paste', (e) => {
        e.preventDefault();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const text = (e.clipboardData ?? window.clipboardData).getData('text/plain');
        document.execCommand('insertText', false, text);
    });
    el.addEventListener('blur', () => {
        if (!el.classList.contains('editing'))
            return;
        el.contentEditable = 'false';
        el.draggable = true;
        el.classList.remove('editing');
        const newContent = el.innerText.trim();
        if (newContent)
            card.content = newContent;
        el.textContent = card.content;
    });
    el.addEventListener('dragstart', (e) => {
        if (el.classList.contains('editing')) {
            e.preventDefault();
            return;
        }
        if (!selected.has(card.id)) {
            selected.clear();
            selected.add(card.id);
        }
        dragInfo = { cardIds: [...selected], fromColId: findColId(card.id) ?? '' };
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', '');
        setTimeout(() => {
            document.querySelectorAll('.card').forEach(c => {
                const isMoved = selected.has(c.dataset['card'] ?? '');
                c.classList.toggle('dragging', isMoved);
                c.classList.toggle('being-moved', isMoved);
            });
        }, 0);
    });
    el.addEventListener('dragend', () => {
        document.querySelectorAll('.card').forEach(c => {
            c.classList.remove('dragging', 'being-moved');
        });
        document.querySelectorAll('.column-cards.drag-over').forEach(c => {
            c.classList.remove('drag-over');
        });
        dragInfo = null;
    });
    el.addEventListener('mousedown', (e) => e.stopPropagation());
    return el;
}
function makeAddColWidget() {
    const wrap = document.createElement('div');
    wrap.className = 'add-col-wrap';
    const btn = document.createElement('button');
    btn.className = 'btn-add-col';
    btn.title = 'カテゴリを追加';
    btn.textContent = '＋';
    btn.addEventListener('mousedown', (e) => e.stopPropagation());
    const form = document.createElement('div');
    form.className = 'add-col-form';
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.className = 'new-cat-input';
    inp.placeholder = 'カテゴリ名';
    inp.addEventListener('mousedown', (e) => e.stopPropagation());
    const okBtn = document.createElement('button');
    okBtn.className = 'btn-sm btn-sm-ok';
    okBtn.textContent = '追加';
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn-sm btn-sm-cancel';
    cancelBtn.textContent = '×';
    form.appendChild(inp);
    form.appendChild(okBtn);
    form.appendChild(cancelBtn);
    wrap.appendChild(btn);
    wrap.appendChild(form);
    const openForm = () => {
        btn.style.display = 'none';
        form.style.display = 'flex';
        inp.value = '';
        inp.focus();
    };
    const closeForm = () => {
        btn.style.display = '';
        form.style.display = 'none';
    };
    const doAdd = () => {
        const name = inp.value.trim();
        if (name) {
            columns.push({ id: uid(), name, cards: [] });
            render();
        }
        else
            closeForm();
    };
    btn.addEventListener('click', openForm);
    okBtn.addEventListener('click', doAdd);
    cancelBtn.addEventListener('click', closeForm);
    inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter')
            doAdd();
        if (e.key === 'Escape')
            closeForm();
    });
    return wrap;
}
// ===== Data helpers =====
function findColId(cardId) {
    for (const col of columns)
        if (col.cards.some(c => c.id === cardId))
            return col.id;
    return null;
}
function doMove(cardIds, toColId) {
    const moving = [];
    for (const col of columns) {
        const kept = [];
        const gone = [];
        for (const c of col.cards)
            (cardIds.includes(c.id) ? gone : kept).push(c);
        moving.push(...gone);
        col.cards = kept;
    }
    const target = columns.find(c => c.id === toColId);
    if (target)
        target.cards.push(...moving);
    selected.clear();
    render();
}
function applySelection() {
    document.querySelectorAll('.card').forEach(el => {
        el.classList.toggle('selected', selected.has(el.dataset['card'] ?? ''));
    });
}
function updateSelBar() {
    const bar = document.getElementById('sel-bar');
    if (!bar)
        return;
    if (selected.size === 0) {
        bar.className = 'sel-bar';
        bar.textContent = 'クリック: 選択 / Ctrl+クリック: 複数選択 / 空白ドラッグ: 範囲選択 / カードドラッグ: 移動 / ダブルクリック: 編集';
    }
    else {
        bar.className = 'sel-bar active';
        bar.textContent = selected.size + ' 枚を選択中 — ドラッグして移動 / Ctrl+クリックで追加選択';
    }
}
// ===== Rubber band =====
document.getElementById('board').addEventListener('mousedown', (e) => {
    if (e.button !== 0 || dragInfo)
        return;
    let t = e.target;
    while (t && t.id !== 'board') {
        if (t.classList.contains('card') ||
            t.classList.contains('column-header') ||
            t.tagName === 'BUTTON' ||
            t.tagName === 'INPUT')
            return;
        t = t.parentElement;
    }
    rb.active = true;
    rb.docX0 = e.clientX + window.scrollX;
    rb.docY0 = e.clientY + window.scrollY;
    rb.lastCX = e.clientX;
    rb.lastCY = e.clientY;
    rb.lastCtrl = e.ctrlKey || e.metaKey;
    rbEl.style.cssText = `left:${e.clientX}px;top:${e.clientY}px;width:0;height:0;display:block;`;
    if (!e.ctrlKey && !e.metaKey) {
        selected.clear();
        applySelection();
    }
    e.preventDefault();
});
function rbApply(clientX, clientY, ctrlOrMeta) {
    rb.lastCX = clientX;
    rb.lastCY = clientY;
    rb.lastCtrl = ctrlOrMeta;
    const docX = clientX + window.scrollX;
    const docY = clientY + window.scrollY;
    const x = Math.min(docX, rb.docX0);
    const y = Math.min(docY, rb.docY0);
    const w = Math.abs(docX - rb.docX0);
    const h = Math.abs(docY - rb.docY0);
    rbEl.style.left = (x - window.scrollX) + 'px';
    rbEl.style.top = (y - window.scrollY) + 'px';
    rbEl.style.width = w + 'px';
    rbEl.style.height = h + 'px';
    document.querySelectorAll('.card:not(.editing)').forEach(cardEl => {
        const r = cardEl.getBoundingClientRect();
        const ct = r.top + window.scrollY, cb = r.bottom + window.scrollY;
        const cl = r.left + window.scrollX, cr = r.right + window.scrollX;
        const overlaps = !(x + w < cl || x > cr || y + h < ct || y > cb);
        const cardId = cardEl.dataset['card'] ?? '';
        if (overlaps)
            selected.add(cardId);
        else if (!ctrlOrMeta)
            selected.delete(cardId);
    });
    applySelection();
    updateSelBar();
}
document.addEventListener('mousemove', (e) => {
    if (!rb.active || dragInfo)
        return;
    rbApply(e.clientX, e.clientY, e.ctrlKey || e.metaKey);
});
window.addEventListener('scroll', () => {
    if (!rb.active)
        return;
    rbApply(rb.lastCX, rb.lastCY, rb.lastCtrl);
}, { passive: true });
document.addEventListener('mouseup', () => {
    if (!rb.active)
        return;
    rb.active = false;
    rbEl.style.display = 'none';
    updateSelBar();
});
// ===== F5 / Ctrl+R / Ctrl+W block =====
// 注意: Ctrl+W・Ctrl+Shift+W（タブ/ウィンドウを閉じる）は主要ブラウザがセキュリティ上の理由で
// スクリプトによる preventDefault を無視するため、キー入力の抑止だけでは閉じられてしまう。
// そのため下の beforeunload ハンドラで、閉じる操作全般（タブを閉じる・ブラウザを閉じる・
// ページ移動など）に対してブラウザ標準の確認ダイアログを表示する形で実効的に防止する。
window.addEventListener('keydown', (e) => {
    const key = e.key.toLowerCase();
    const isCloseTab = (e.ctrlKey || e.metaKey) && !e.shiftKey && key === 'w';
    const isCloseWindow = (e.ctrlKey || e.metaKey) && e.shiftKey && key === 'w';
    if (e.key === 'F5' || (e.ctrlKey && key === 'r') || isCloseTab || isCloseWindow) {
        e.preventDefault();
        e.stopPropagation();
    }
}, true);
window.addEventListener('beforeunload', (e) => {
    e.preventDefault();
    e.returnValue = '';
});
// ===== Org utilities =====
function orgIsOutline(line) {
    return /^\*+ /.test(line);
}
function orgLevel(line) {
    const m = line.match(/^(\*+)/);
    return m ? m[1].length : 0;
}
function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
// ===== モーダルダイアログ（ブラウザ標準の alert/confirm の代替） =====
// ブラウザ標準ダイアログは画面上部に固定表示されマウス移動距離が長くなるため、
// 画面中央に表示される自作モーダルに統一する。
function orgModalAlert(message) {
    return new Promise(resolve => {
        const overlay = document.createElement('div');
        overlay.className = 'text-bulk-overlay';
        const box = document.createElement('div');
        box.className = 'text-bulk-box org-modal-box';
        const p = document.createElement('p');
        p.className = 'org-modal-message';
        p.textContent = message;
        const btnRow = document.createElement('div');
        btnRow.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;';
        const okBtn = document.createElement('button');
        okBtn.textContent = 'OK';
        okBtn.style.cssText = 'padding:5px 16px;font-size:0.82rem;font-weight:600;border-radius:6px;cursor:pointer;';
        let resolved = false;
        const finish = () => {
            if (resolved)
                return;
            resolved = true;
            document.removeEventListener('keydown', onKey, true);
            if (document.body.contains(overlay))
                document.body.removeChild(overlay);
            resolve();
        };
        const onKey = (e) => {
            e.stopImmediatePropagation();
            if (e.key === 'Enter' || e.key === 'Escape') {
                e.preventDefault();
                finish();
            }
        };
        okBtn.addEventListener('click', finish);
        document.addEventListener('keydown', onKey, true);
        btnRow.appendChild(okBtn);
        box.appendChild(p);
        box.appendChild(btnRow);
        overlay.appendChild(box);
        document.body.appendChild(overlay);
        setTimeout(() => okBtn.focus({ preventScroll: true }), 50);
    });
}
function orgModalConfirm(message) {
    return new Promise(resolve => {
        const overlay = document.createElement('div');
        overlay.className = 'text-bulk-overlay';
        const box = document.createElement('div');
        box.className = 'text-bulk-box org-modal-box';
        const p = document.createElement('p');
        p.className = 'org-modal-message';
        p.textContent = message;
        const btnRow = document.createElement('div');
        btnRow.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;';
        const okBtn = document.createElement('button');
        okBtn.textContent = 'OK';
        okBtn.style.cssText = 'padding:5px 16px;font-size:0.82rem;font-weight:600;border-radius:6px;cursor:pointer;';
        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'btn';
        cancelBtn.textContent = 'キャンセル';
        cancelBtn.style.cssText = 'padding:5px 16px;background:#95a5a6;color:#fff;';
        let resolved = false;
        const finish = (result) => {
            if (resolved)
                return;
            resolved = true;
            document.removeEventListener('keydown', onKey, true);
            if (document.body.contains(overlay))
                document.body.removeChild(overlay);
            resolve(result);
        };
        const onKey = (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                finish(true);
            }
            else if (e.key === 'Escape') {
                e.preventDefault();
                finish(false);
            }
        };
        okBtn.addEventListener('click', () => finish(true));
        cancelBtn.addEventListener('click', () => finish(false));
        document.addEventListener('keydown', onKey, true);
        btnRow.appendChild(okBtn);
        btnRow.appendChild(cancelBtn);
        box.appendChild(p);
        box.appendChild(btnRow);
        overlay.appendChild(box);
        document.body.appendChild(overlay);
        setTimeout(() => okBtn.focus({ preventScroll: true }), 50);
    });
}
function orgGetOutlines(content) {
    const lines = content.split('\n');
    const result = [];
    let charPos = 0;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (orgIsOutline(line)) {
            const lv = orgLevel(line);
            result.push({ lineIndex: i, charPos, text: line, level: lv });
        }
        charPos += line.length + 1;
    }
    return result;
}
function charPosToLineIndex(content, charPos) {
    return content.substring(0, charPos).split('\n').length - 1;
}
function orgCountNonBlank(text) {
    return text.split('\n').filter(l => l.trim() !== '').length;
}
function getOutlineSectionRange(content, charPos) {
    const lines = content.split('\n');
    const outlines = orgGetOutlines(content);
    const selIdx = outlines.findIndex(o => o.charPos === charPos);
    if (selIdx === -1)
        return null;
    const sel = outlines[selIdx];
    let endLine = lines.length;
    for (let i = selIdx + 1; i < outlines.length; i++) {
        if (outlines[i].level <= sel.level) {
            endLine = outlines[i].lineIndex;
            break;
        }
    }
    return { start: sel.lineIndex, end: endLine };
}
/** outlines[idx] が子（自分より深いレベルの直後のアウトライン）を持つかどうか。 */
function orgOutlineHasChildren(outlines, idx) {
    return idx + 1 < outlines.length && outlines[idx + 1].level > outlines[idx].level;
}
/**
 * 折りたたみ中（collapsed）のアウトラインの子孫を非表示にするため、outlines と同じ順序で
 * 各アウトラインの表示可否を計算する。祖先のいずれかが折りたたまれていれば非表示。
 */
function orgComputeOutlineVisibility(outlines, collapsed) {
    const visible = [];
    const collapseStack = []; // 現在有効な（祖先の）折りたたみレベルのスタック
    for (const o of outlines) {
        while (collapseStack.length > 0 && collapseStack[collapseStack.length - 1] >= o.level) {
            collapseStack.pop();
        }
        visible.push(collapseStack.length === 0);
        if (collapsed.has(o.charPos))
            collapseStack.push(o.level);
    }
    return visible;
}
/**
 * 一覧に表示するアウトラインの表示可否を計算する。絞り込み検索文字列が入力されている間は、
 * 折りたたみ状態を無視してテキストが一致するものだけをフラットに表示する。
 * 検索文字列が空なら折りたたみ状態に基づく通常の表示可否（orgComputeOutlineVisibility）を使う。
 */
function orgComputeOutlineDisplayVisibility(outlines, collapsed, searchQuery) {
    const q = searchQuery.trim().toLowerCase();
    if (q)
        return outlines.map(o => o.text.toLowerCase().includes(q));
    return orgComputeOutlineVisibility(outlines, collapsed);
}
/** トップレベル（レベル1）のうち子を持つアウトラインを対象に、全て折りたたむ/全て展開をトグルする。 */
function orgToggleCollapseAll(outlines, collapsed) {
    const topLevelWithChildren = outlines.filter((o, i) => o.level === 1 && orgOutlineHasChildren(outlines, i));
    if (topLevelWithChildren.length === 0)
        return;
    const allCollapsed = topLevelWithChildren.every(o => collapsed.has(o.charPos));
    if (allCollapsed) {
        topLevelWithChildren.forEach(o => collapsed.delete(o.charPos));
    }
    else {
        topLevelWithChildren.forEach(o => collapsed.add(o.charPos));
    }
}
/** 現在 orgReorderSelectedOutlines に選択されているアウトラインのレベル（未選択なら null）。 */
function orgReorderSelectionLevel(outlines) {
    if (orgReorderSelectedOutlines.size === 0)
        return null;
    const firstCp = orgReorderSelectedOutlines.values().next().value;
    const found = outlines.find(o => o.charPos === firstCp);
    return found ? found.level : null;
}
/** ファイル振り分け表示中でない場合の .org-outline-item の選択ハイライトを、単一選択と並べ替え用複数選択の両方を反映して同期する。 */
function orgApplyOutlineSelectionVisual() {
    if (orgFileDropActive) {
        orgApplyFileDropOutlineSelection();
        return;
    }
    document.querySelectorAll('.org-outline-item').forEach(el => {
        const cp = Number(el.dataset['charPos']);
        el.classList.toggle('selected', cp === orgSelectedCharPos || orgReorderSelectedOutlines.has(cp));
    });
}
/**
 * セクション（見出し行を含む range）の本文部分を、空行区切りの「カード」に分割する。
 * 見出し行自体（range.start）はカードに含めない。
 */
function orgGetSectionCards(content, range) {
    const bodyStart = range.start + 1;
    const bodyEnd = range.end;
    if (bodyStart >= bodyEnd)
        return [];
    const lines = content.split('\n');
    const bodyLines = lines.slice(bodyStart, bodyEnd);
    return splitLinesIntoBlocks(bodyLines).map(b => ({
        text: bodyLines.slice(b.start, b.end).join('\n').trim(),
        startLine: bodyStart + b.start,
        endLine: bodyStart + b.end,
    }));
}
// ===== High-performance file content render using innerHTML =====
// Only renders lines in showRange (with actual file line numbers).
// For large files this avoids creating thousands of DOM nodes.
function renderWithLineNumbers(container, text, options) {
    const allLines = text.split('\n');
    const totalLines = (allLines.length > 1 && allLines[allLines.length - 1] === '')
        ? allLines.slice(0, -1) : allLines;
    const startIdx = options?.showRange?.start ?? 0;
    const endIdx = Math.min(options?.showRange?.end ?? totalLines.length, totalLines.length);
    const digits = String(endIdx).length;
    const hlRange = options?.highlightRange;
    const hlClass = options?.highlightClass ?? 'hl-section';
    const cardRanges = options?.cardRanges ?? [];
    const rows = [];
    let cardIdx = 0;
    for (let i = startIdx; i < endIdx; i++) {
        const inCard = cardIdx < cardRanges.length && i >= cardRanges[cardIdx].start && i < cardRanges[cardIdx].end;
        if (inCard && i === cardRanges[cardIdx].start) {
            rows.push(`<div class="cmp-card" draggable="true" data-card-start="${cardRanges[cardIdx].start}" data-card-end="${cardRanges[cardIdx].end}">`);
        }
        const line = totalLines[i];
        const lineStr = String(i + 1).padStart(digits, ' ');
        let rowClass = 'cmp-row';
        if (hlRange && i >= hlRange.start && i < hlRange.end) {
            rowClass += ' ' + hlClass;
        }
        const escaped = escapeHtml(line);
        const lineHtml = orgIsOutline(line)
            ? `<span class="cmp-line org-lv${Math.min(orgLevel(line), 4)}">${escaped}</span>`
            : `<span class="cmp-line">${escaped}</span>`;
        rows.push(`<div class="${rowClass}"><span class="cmp-num">${lineStr}</span>${lineHtml}</div>`);
        if (inCard && i === cardRanges[cardIdx].end - 1) {
            rows.push('</div>');
            cardIdx++;
        }
    }
    container.innerHTML = `<pre class="cmp-view">${rows.join('')}</pre>`;
    if (cardRanges.length > 0) {
        container.querySelectorAll('.cmp-card').forEach(cardEl => {
            cardEl.addEventListener('dragstart', (e) => {
                const s = parseInt(cardEl.dataset['cardStart'] ?? '-1', 10);
                const en = parseInt(cardEl.dataset['cardEnd'] ?? '-1', 10);
                if (s < 0 || en < 0) {
                    e.preventDefault();
                    return;
                }
                orgDraggedSectionCard = { startLine: s, endLine: en };
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', '');
                cardEl.classList.add('dragging');
            });
            cardEl.addEventListener('dragend', () => {
                cardEl.classList.remove('dragging');
                orgDraggedSectionCard = null;
                // dragleave が確実に発火するとは限らないため、念のため残ってしまった枠をすべて消す
                document.querySelectorAll('.org-outline-item.drag-over').forEach(el => {
                    el.classList.remove('drag-over');
                });
            });
        });
    }
    if (options?.scrollTo !== undefined) {
        const relIdx = options.scrollTo - startIdx;
        if (relIdx >= 0) {
            const rowEls = container.querySelectorAll('.cmp-row');
            const target = rowEls[relIdx];
            if (target) {
                container.scrollTop = Math.max(0, target.offsetTop - 5 * (target.offsetHeight || 20));
            }
        }
    }
}
/** ファイル振り分け表示中の複数選択状態を、既存の .org-outline-item 要素へ反映する（再描画はしない）。 */
function orgApplyFileDropOutlineSelection() {
    document.querySelectorAll('.org-outline-item').forEach(el => {
        el.classList.toggle('selected', orgFileDropSelectedOutlines.has(Number(el.dataset['charPos'])));
    });
}
// ===== アウトライン一覧ラバーバンド選択（ファイル振り分け時の複数選択用） =====
(function initOrgOutlineRubberBand() {
    const selBox = document.getElementById('org-outline-sel-box');
    let active = false;
    let docStartX = 0, docStartY = 0;
    let lastClientX = 0, lastClientY = 0, lastCtrl = false;
    function apply(clientX, clientY, ctrlOrMeta) {
        lastClientX = clientX;
        lastClientY = clientY;
        lastCtrl = ctrlOrMeta;
        const docX = clientX + window.scrollX;
        const docY = clientY + window.scrollY;
        const x = Math.min(docX, docStartX);
        const y = Math.min(docY, docStartY);
        const w = Math.abs(docX - docStartX);
        const h = Math.abs(docY - docStartY);
        selBox.style.left = (x - window.scrollX) + 'px';
        selBox.style.top = (y - window.scrollY) + 'px';
        selBox.style.width = w + 'px';
        selBox.style.height = h + 'px';
        document.querySelectorAll('#org-outline .org-outline-item').forEach(itemEl => {
            const r = itemEl.getBoundingClientRect();
            const il = r.left + window.scrollX, ir = r.right + window.scrollX;
            const it = r.top + window.scrollY, ib = r.bottom + window.scrollY;
            const overlaps = !(x + w < il || x > ir || y + h < it || y > ib);
            const cp = Number(itemEl.dataset['charPos']);
            if (overlaps)
                orgFileDropSelectedOutlines.add(cp);
            else if (!ctrlOrMeta)
                orgFileDropSelectedOutlines.delete(cp);
        });
        orgApplyFileDropOutlineSelection();
    }
    document.addEventListener('mousedown', (e) => {
        if (e.button !== 0 || !orgFileDropActive)
            return;
        const target = e.target;
        if (!target.closest('#org-outline'))
            return;
        if (target.closest('.org-outline-item') || target.closest('button') || target.closest('input'))
            return;
        active = true;
        docStartX = e.clientX + window.scrollX;
        docStartY = e.clientY + window.scrollY;
        selBox.style.cssText = `left:${e.clientX}px;top:${e.clientY}px;width:0;height:0;display:block;`;
        if (!e.ctrlKey && !e.metaKey) {
            orgFileDropSelectedOutlines.clear();
            orgApplyFileDropOutlineSelection();
        }
        e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
        if (!active)
            return;
        apply(e.clientX, e.clientY, e.ctrlKey || e.metaKey);
    });
    window.addEventListener('scroll', () => {
        if (!active)
            return;
        apply(lastClientX, lastClientY, lastCtrl);
    }, { passive: true });
    document.addEventListener('mouseup', () => {
        if (!active)
            return;
        active = false;
        selBox.style.display = 'none';
    });
})();
// ===== アウトライン一覧同士の並べ替え用ラバーバンド選択（同じレベルのみ複数選択可、ファイル振り分け表示中は無効） =====
(function initOrgOutlineReorderRubberBand() {
    const selBox = document.getElementById('org-reorder-sel-box');
    let active = false;
    let docStartX = 0, docStartY = 0;
    let lastClientX = 0, lastClientY = 0, lastCtrl = false;
    function apply(clientX, clientY, ctrlOrMeta) {
        lastClientX = clientX;
        lastClientY = clientY;
        lastCtrl = ctrlOrMeta;
        const docX = clientX + window.scrollX;
        const docY = clientY + window.scrollY;
        const x = Math.min(docX, docStartX);
        const y = Math.min(docY, docStartY);
        const w = Math.abs(docX - docStartX);
        const h = Math.abs(docY - docStartY);
        selBox.style.left = (x - window.scrollX) + 'px';
        selBox.style.top = (y - window.scrollY) + 'px';
        selBox.style.width = w + 'px';
        selBox.style.height = h + 'px';
        const outlines = orgGetOutlines(orgOriginalContent);
        document.querySelectorAll('.org-outline-item').forEach(itemEl => {
            const r = itemEl.getBoundingClientRect();
            const il = r.left + window.scrollX, ir = r.right + window.scrollX;
            const it = r.top + window.scrollY, ib = r.bottom + window.scrollY;
            const overlaps = !(x + w < il || x > ir || y + h < it || y > ib);
            const cp = Number(itemEl.dataset['charPos']);
            if (overlaps) {
                const outline = outlines.find(o => o.charPos === cp);
                const lockedLevel = orgReorderSelectionLevel(outlines);
                if (outline && (lockedLevel === null || outline.level === lockedLevel))
                    orgReorderSelectedOutlines.add(cp);
            }
            else if (!ctrlOrMeta) {
                orgReorderSelectedOutlines.delete(cp);
            }
        });
        orgApplyOutlineSelectionVisual();
    }
    document.addEventListener('mousedown', (e) => {
        if (e.button !== 0 || orgFileDropActive)
            return;
        const target = e.target;
        const inLeftList = target.closest('#org-outline');
        const inMirrorList = orgOutline2Active && target.closest('#org-form2');
        if (!inLeftList && !inMirrorList)
            return;
        if (target.closest('.org-outline-item') || target.closest('button') || target.closest('input'))
            return;
        active = true;
        docStartX = e.clientX + window.scrollX;
        docStartY = e.clientY + window.scrollY;
        selBox.style.cssText = `left:${e.clientX}px;top:${e.clientY}px;width:0;height:0;display:block;`;
        if (!e.ctrlKey && !e.metaKey) {
            orgReorderSelectedOutlines.clear();
            orgApplyOutlineSelectionVisual();
        }
        e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
        if (!active)
            return;
        apply(e.clientX, e.clientY, e.ctrlKey || e.metaKey);
    });
    window.addEventListener('scroll', () => {
        if (!active)
            return;
        apply(lastClientX, lastClientY, lastCtrl);
    }, { passive: true });
    document.addEventListener('mouseup', () => {
        if (!active)
            return;
        active = false;
        selBox.style.display = 'none';
    });
})();
// ===== Org outline render =====
function orgRenderOutline(content) {
    const el = document.getElementById('org-outline');
    if (!el)
        return;
    el.innerHTML = '';
    if (!content)
        return;
    const outlines = orgGetOutlines(content);
    const countEl = document.getElementById('org-outline-count');
    if (countEl)
        countEl.textContent = `${outlines.length}件`;
    // Precompute section ranges for all items
    const ranges = outlines.map(item => getOutlineSectionRange(content, item.charPos));
    const visibility = orgComputeOutlineDisplayVisibility(outlines, orgCollapsedOutlines, orgOutlineSearchQuery);
    // Display order: always follow the actual file order
    const displayIndices = outlines.map((_, i) => i);
    for (const i of displayIndices) {
        if (!visibility[i])
            continue;
        const item = outlines[i];
        const range = ranges[i];
        const lineCount = range ? range.end - range.start : 0;
        const hasChildren = orgOutlineHasChildren(outlines, i);
        const div = document.createElement('div');
        div.className = 'org-outline-item lv' + Math.min(item.level, 4);
        div.title = item.text;
        div.dataset['charPos'] = String(item.charPos);
        if (orgFileDropActive) {
            if (orgFileDropSelectedOutlines.has(item.charPos))
                div.classList.add('selected');
        }
        else if (item.charPos === orgSelectedCharPos || orgReorderSelectedOutlines.has(item.charPos)) {
            div.classList.add('selected');
        }
        const foldToggle = document.createElement('span');
        foldToggle.className = 'org-outline-fold-toggle' + (hasChildren ? '' : ' no-children');
        foldToggle.textContent = hasChildren ? (orgCollapsedOutlines.has(item.charPos) ? '▶' : '▼') : '';
        if (hasChildren) {
            foldToggle.addEventListener('click', (e) => {
                e.stopPropagation();
                orgCollapsedOutlines.has(item.charPos) ? orgCollapsedOutlines.delete(item.charPos) : orgCollapsedOutlines.add(item.charPos);
                orgRenderOutline(orgOriginalContent);
            });
        }
        const textSpan = document.createElement('span');
        textSpan.className = 'org-outline-item-text';
        textSpan.textContent = item.text;
        const countSpan = document.createElement('span');
        countSpan.className = 'org-outline-count';
        countSpan.textContent = `${lineCount}行`;
        div.appendChild(foldToggle);
        div.appendChild(textSpan);
        div.appendChild(countSpan);
        div.addEventListener('click', (e) => {
            if (orgFileDropActive) {
                if (e.ctrlKey || e.metaKey) {
                    orgFileDropSelectedOutlines.has(item.charPos)
                        ? orgFileDropSelectedOutlines.delete(item.charPos)
                        : orgFileDropSelectedOutlines.add(item.charPos);
                }
                else {
                    const onlyThis = orgFileDropSelectedOutlines.size === 1 && orgFileDropSelectedOutlines.has(item.charPos);
                    orgFileDropSelectedOutlines.clear();
                    if (!onlyThis)
                        orgFileDropSelectedOutlines.add(item.charPos);
                }
                orgApplyFileDropOutlineSelection();
                return;
            }
            if (e.ctrlKey || e.metaKey) {
                if (orgReorderSelectedOutlines.has(item.charPos)) {
                    orgReorderSelectedOutlines.delete(item.charPos);
                }
                else {
                    const lockedLevel = orgReorderSelectionLevel(outlines);
                    if (lockedLevel !== null && lockedLevel !== item.level) {
                        void orgModalAlert('複数選択できるのは同じレベルのアウトラインのみです');
                    }
                    else {
                        orgReorderSelectedOutlines.add(item.charPos);
                    }
                }
                orgApplyOutlineSelectionVisual();
                return;
            }
            orgReorderSelectedOutlines.clear();
            el.querySelectorAll('.org-outline-item').forEach(d => d.classList.remove('selected'));
            div.classList.add('selected');
            orgSelectedCharPos = item.charPos;
            orgSelectedRange = range;
            orgUpdateSectionCurrentHeading(item);
            orgLeaveOutline2Tab(); // 「アウトライン一覧」タブ表示中なら、スクロール位置を保存して「セクション内容」タブへ戻す
            const container = document.getElementById('org-form2');
            if (range) {
                renderWithLineNumbers(container, content, {
                    showRange: range,
                    cardRanges: orgSectionCardModeActive
                        ? orgGetSectionCards(content, range).map(c => ({ start: c.startLine, end: c.endLine }))
                        : undefined,
                });
                container.scrollTop = 0;
                const infoEl = document.getElementById('org-section-info');
                if (infoEl) {
                    infoEl.textContent = `${range.start + 1}〜${range.end}行（${lineCount}行）`;
                }
            }
        });
        div.addEventListener('dblclick', (e) => {
            e.stopPropagation();
            // レベル（"*" の数）も含めた見出し行全体をテキストとして編集できるようにする
            const currentLine = item.text;
            const input = document.createElement('input');
            input.type = 'text';
            input.className = 'org-outline-edit-input';
            input.value = currentLine;
            textSpan.replaceWith(input);
            input.focus();
            input.select();
            let cancelled = false;
            // モーダル表示中にモーダル側のボタンへフォーカスが移ると input が blur し、
            // blur リスナーが applyEdit を再度呼んでしまう（確認モーダルが二重に開く・保存が
            // 意図せず先に走る原因になる）ため、処理中は busy で再入を防ぐ。
            let busy = false;
            const cancelEdit = () => {
                cancelled = true;
                input.replaceWith(textSpan);
            };
            const applyEdit = async () => {
                if (cancelled || busy)
                    return;
                busy = true;
                // タイトルが空（"*+" の後が空白のみ）の場合、末尾スペース全除去だと見出しの必須スペースまで
                // 消えてしまうため、その場合だけ1つスペースを残す。
                const newLine = /^\*+\s*$/.test(input.value)
                    ? input.value.replace(/^(\*+)\s*$/, '$1 ')
                    : input.value.replace(/\s+$/, '');
                if (newLine === currentLine) {
                    cancelEdit();
                    return;
                }
                if (!orgIsOutline(newLine)) {
                    busy = false;
                    await orgModalAlert('見出しの形式が正しくありません。「*」を1つ以上の後に半角スペース、続けてタイトルを入力してください。（例: ** TODO 買い物）');
                    input.focus();
                    return;
                }
                const confirmed = await orgModalConfirm('アウトラインを変更します:\n\n' +
                    '変更前: ' + currentLine + '\n' +
                    '変更後: ' + newLine + '\n\n' +
                    'OKを押すと上書き保存します。');
                if (!confirmed) {
                    busy = false;
                    cancelEdit();
                    return;
                }
                const selectedLineIdx = orgSelectedCharPos !== null
                    ? charPosToLineIndex(orgOriginalContent, orgSelectedCharPos) : -1;
                const lines = orgOriginalContent.split('\n');
                lines[item.lineIndex] = newLine;
                const newContent = lines.join('\n');
                const saved = await saveOrgContent(newContent);
                if (!saved) {
                    busy = false;
                    cancelEdit();
                    return;
                }
                orgOriginalContent = newContent;
                if (selectedLineIdx >= 0) {
                    const newOutlines = orgGetOutlines(orgOriginalContent);
                    const sel = newOutlines.find(o => o.lineIndex === selectedLineIdx);
                    orgSelectedCharPos = sel ? sel.charPos : null;
                    orgSelectedRange = orgSelectedCharPos !== null
                        ? getOutlineSectionRange(orgOriginalContent, orgSelectedCharPos) : null;
                }
                cancelled = true;
                updateTotalLines(orgOriginalContent);
                orgRenderOutline(orgOriginalContent);
            };
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    void applyEdit();
                }
                else if (e.key === 'Escape') {
                    e.preventDefault();
                    cancelEdit();
                }
            });
            input.addEventListener('blur', () => { void applyEdit(); });
        });
        div.draggable = true;
        div.addEventListener('dragstart', (e) => {
            // ファイル振り分け表示中、未選択のアウトラインをドラッグした場合はそのアウトライン単独の選択にする
            // （ドラッグしたものが選択に含まれていないと、選択中の別アイテムが意図せず移動されてしまうため）
            if (orgFileDropActive) {
                if (!orgFileDropSelectedOutlines.has(item.charPos)) {
                    orgFileDropSelectedOutlines.clear();
                    orgFileDropSelectedOutlines.add(item.charPos);
                    orgApplyFileDropOutlineSelection();
                }
                orgDraggedOutlineCharPositions = [...orgFileDropSelectedOutlines];
            }
            else {
                // 並べ替え用に複数選択（同じレベルのみ）していた場合は、選択中の全アウトラインをまとめてドラッグする
                if (orgReorderSelectedOutlines.size > 0 && !orgReorderSelectedOutlines.has(item.charPos)) {
                    orgReorderSelectedOutlines.clear();
                    orgApplyOutlineSelectionVisual();
                }
                orgDraggedOutlineCharPositions = orgReorderSelectedOutlines.has(item.charPos)
                    ? [...orgReorderSelectedOutlines]
                    : [item.charPos];
            }
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', '');
            const positions = orgDraggedOutlineCharPositions;
            document.querySelectorAll('.org-outline-item').forEach(itemEl => {
                if (positions.includes(Number(itemEl.dataset['charPos'])))
                    itemEl.classList.add('dragging');
            });
        });
        div.addEventListener('dragend', () => {
            orgDraggedOutlineCharPositions = null;
            // dragleave が確実に発火するとは限らないため、念のため残ってしまった枠・背景色をすべて消す
            document.querySelectorAll('.file-drop-item.drag-over, .org-outline-item.drag-over, .org-outline-item.dragging, .file-drop-root-over').forEach(el => {
                el.classList.remove('drag-over', 'dragging', 'file-drop-root-over');
            });
        });
        // セクション内容のカードをドロップされたら、このアウトラインの末尾へ移動する。
        // また、他のアウトライン（左右どちらのアウトライン一覧からでも）がドロップされたら、任意の位置への移動として処理する。
        div.addEventListener('dragover', (e) => {
            if (orgDraggedSectionCard === null && orgDraggedOutlineCharPositions === null)
                return;
            e.preventDefault();
            div.classList.add('drag-over');
        });
        div.addEventListener('dragleave', () => div.classList.remove('drag-over'));
        div.addEventListener('drop', (e) => {
            if (orgDraggedSectionCard !== null) {
                e.preventDefault();
                e.stopPropagation();
                div.classList.remove('drag-over');
                void orgHandleSectionCardDropOnOutline(item, orgDraggedSectionCard);
                return;
            }
            if (orgDraggedOutlineCharPositions !== null) {
                e.preventDefault();
                e.stopPropagation();
                div.classList.remove('drag-over');
                void orgHandleOutlineReorderDrop(item.charPos);
                return;
            }
        });
        div.tabIndex = 0;
        div.addEventListener('keydown', (e) => {
            // 見出し編集中の <input> 等、div自身以外がフォーカスされている間はこのハンドラを無効にする
            // （編集用テキスト欄でスペースキーが入力できなくなる不具合の原因だったため）
            if (e.target !== div)
                return;
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                div.click();
                return;
            }
            if (e.key !== 'Tab' && e.key !== 'ArrowUp' && e.key !== 'ArrowDown')
                return;
            const items = Array.from(el.querySelectorAll('.org-outline-item'));
            const idx = items.indexOf(div);
            e.preventDefault();
            if (e.key === 'ArrowDown') {
                if (idx < items.length - 1) {
                    items[idx + 1].focus();
                    items[idx + 1].scrollIntoView({ block: 'nearest' });
                }
            }
            else if (e.key === 'ArrowUp') {
                if (idx > 0) {
                    items[idx - 1].focus();
                    items[idx - 1].scrollIntoView({ block: 'nearest' });
                }
            }
            else if (!e.shiftKey) {
                if (idx < items.length - 1) {
                    items[idx + 1].focus();
                    items[idx + 1].scrollIntoView({ block: 'nearest' });
                }
                else {
                    document.getElementById('org-load-btn')?.focus();
                }
            }
            else {
                if (idx > 0) {
                    items[idx - 1].focus();
                    items[idx - 1].scrollIntoView({ block: 'nearest' });
                }
                else {
                    document.getElementById('org-load-btn')?.focus();
                }
            }
        });
        el.appendChild(div);
    }
    if (orgOutlineSearchQuery.trim() && visibility.every(v => !v)) {
        const p = document.createElement('p');
        p.className = 'org-form-placeholder';
        p.textContent = '該当するアウトラインがありません';
        el.appendChild(p);
    }
    if (orgOutline2Active)
        orgRenderOutlineMirrorList();
}
function orgUpdateSectionCurrentHeading(item) {
    const el = document.getElementById('org-section-current-heading');
    if (!el)
        return;
    if (!item) {
        el.textContent = '';
        el.className = 'org-section-current-heading';
        return;
    }
    el.textContent = item.text;
    el.className = 'org-section-current-heading org-lv' + Math.min(item.level, 4);
}
function orgShowSectionForSelected() {
    if (orgFileDropActive || orgOutline2Active)
        return; // ファイル振り分け／アウトライン一覧表示中はその表示を維持する
    const container = document.getElementById('org-form2');
    if (orgSelectedCharPos === null) {
        container.innerHTML = '<p class="org-form-placeholder">アウトラインを選択するとセクション内容が表示されます</p>';
        const infoEl = document.getElementById('org-section-info');
        if (infoEl)
            infoEl.textContent = '';
        orgUpdateSectionCurrentHeading(null);
        return;
    }
    const range = getOutlineSectionRange(orgOriginalContent, orgSelectedCharPos);
    orgSelectedRange = range;
    const selectedItem = orgGetOutlines(orgOriginalContent).find(o => o.charPos === orgSelectedCharPos) ?? null;
    orgUpdateSectionCurrentHeading(selectedItem);
    if (range) {
        const lineCount = range.end - range.start;
        renderWithLineNumbers(container, orgOriginalContent, {
            showRange: range,
            cardRanges: orgSectionCardModeActive
                ? orgGetSectionCards(orgOriginalContent, range).map(c => ({ start: c.startLine, end: c.endLine }))
                : undefined,
        });
        container.scrollTop = 0;
        const infoEl = document.getElementById('org-section-info');
        if (infoEl)
            infoEl.textContent = `${range.start + 1}〜${range.end}行（${lineCount}行）`;
    }
}
function updateTotalLines(content) {
    const el = document.getElementById('org-total-lines');
    if (!el)
        return;
    if (!content) {
        el.textContent = '';
        return;
    }
    const lines = content.split('\n').filter((_, i, a) => i < a.length - 1 || a[i] !== '').length;
    el.textContent = `全${lines}行`;
}
function updateFileStats() {
    const infoEl = document.getElementById('org-section-info');
    if (!infoEl)
        return;
    if (!orgOriginalContent) {
        infoEl.textContent = '';
        return;
    }
    if (orgSelectedRange)
        return; // already set by outline click
    const lines = orgOriginalContent.split('\n').length;
    infoEl.textContent = `全${lines}行`;
}
// ===== Outline drag-to-file (振り分け) =====
function orgRenderFileDropList() {
    const container = document.getElementById('org-form2');
    container.classList.add('file-drop-list');
    container.innerHTML = '';
    // 操作行: 新規ファイル作成 / 再読込 / フォルダ変更（ラベルより上に配置）
    const actions = document.createElement('div');
    actions.className = 'file-drop-actions';
    const newFileBtn = document.createElement('button');
    newFileBtn.className = 'btn-scroll';
    newFileBtn.textContent = '新規ファイル作成';
    newFileBtn.addEventListener('click', () => orgShowCreateFileModal());
    actions.appendChild(newFileBtn);
    const reloadBtn = document.createElement('button');
    reloadBtn.className = 'btn-scroll';
    reloadBtn.textContent = '再読込';
    reloadBtn.title = '同じフォルダのファイル一覧を読み込み直します（他で追加されたファイルを反映）';
    reloadBtn.addEventListener('click', () => { void orgReloadFileDropList(); });
    actions.appendChild(reloadBtn);
    const changeFolderBtn = document.createElement('button');
    changeFolderBtn.className = 'btn-scroll';
    changeFolderBtn.textContent = 'フォルダ変更';
    changeFolderBtn.title = '別のフォルダを選択し直します';
    changeFolderBtn.addEventListener('click', () => { void orgActivateFileDropMode(); });
    actions.appendChild(changeFolderBtn);
    container.appendChild(actions);
    const header = document.createElement('div');
    header.className = 'file-drop-header';
    const label = document.createElement('span');
    label.textContent = 'アウトラインをドラッグしてファイルへ移動（Ctrl+クリック／ドラッグで範囲選択すると複数選択してまとめて移動できます）';
    header.appendChild(label);
    container.appendChild(header);
    // 検索行: ファイル一覧のリアルタイム絞り込み（ラベルより下に配置）
    const searchRow = document.createElement('div');
    searchRow.className = 'file-drop-actions';
    const searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.className = 'file-drop-search-input';
    searchInput.placeholder = 'ファイル名で絞り込み';
    searchInput.autocomplete = 'off';
    searchInput.value = orgFileDropSearchQuery;
    searchInput.addEventListener('input', () => {
        orgFileDropSearchQuery = searchInput.value;
        orgRenderFileDropItems();
    });
    searchRow.appendChild(searchInput);
    container.appendChild(searchRow);
    const itemsContainer = document.createElement('div');
    itemsContainer.className = 'file-drop-items';
    container.appendChild(itemsContainer);
    orgFileDropItemsContainer = itemsContainer;
    orgRenderFileDropItems();
}
/** ファイル一覧の項目部分だけを再描画する（検索欄の入力・フォーカスを保ったまま絞り込むため）。 */
function orgRenderFileDropItems() {
    const itemsContainer = orgFileDropItemsContainer;
    if (!itemsContainer)
        return;
    itemsContainer.innerHTML = '';
    if (orgFileDropEntries.length === 0) {
        const p = document.createElement('p');
        p.className = 'org-form-placeholder';
        p.textContent = 'フォルダ内に .org ファイルが見つかりませんでした';
        itemsContainer.appendChild(p);
        return;
    }
    const query = orgFileDropSearchQuery.trim().toLowerCase();
    const visibleEntries = query
        ? orgFileDropEntries.filter(entry => entry.path.toLowerCase().includes(query))
        : orgFileDropEntries;
    if (visibleEntries.length === 0) {
        const p = document.createElement('p');
        p.className = 'org-form-placeholder';
        p.textContent = '絞り込み条件に一致するファイルがありません';
        itemsContainer.appendChild(p);
        return;
    }
    for (const entry of visibleEntries) {
        const item = document.createElement('div');
        item.className = 'file-drop-item';
        item.textContent = entry.path;
        item.title = `${entry.path}\n（右クリックでこのファイルをファイルパスに設定）`;
        item.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            void orgOpenFileDropEntry(entry);
        });
        item.addEventListener('dragover', (e) => {
            if (orgDraggedOutlineCharPositions === null)
                return;
            e.preventDefault();
            item.classList.add('drag-over');
        });
        item.addEventListener('dragleave', () => item.classList.remove('drag-over'));
        item.addEventListener('drop', (e) => {
            e.preventDefault();
            e.stopPropagation();
            item.classList.remove('drag-over');
            void orgHandleOutlineDropOnFile(entry);
        });
        itemsContainer.appendChild(item);
    }
}
/** 新規ファイル名を入力するモーダルを表示する。OKなら選択中フォルダのルートに .org ファイルを作成する。 */
function orgShowCreateFileModal() {
    if (!orgFileDropDir)
        return;
    const overlay = document.createElement('div');
    overlay.className = 'text-bulk-overlay';
    const box = document.createElement('div');
    box.className = 'text-bulk-box';
    const p = document.createElement('p');
    p.textContent = '新規ファイル名を入力してください（拡張子は自動的に .org になります）:';
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.className = 'text-bulk-inp';
    inp.placeholder = 'ファイル名';
    inp.autocomplete = 'off';
    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;margin-top:8px;';
    const okBtn = document.createElement('button');
    okBtn.className = 'btn btn-blue';
    okBtn.textContent = '作成';
    okBtn.style.padding = '5px 16px';
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn';
    cancelBtn.textContent = 'キャンセル';
    cancelBtn.style.cssText = 'padding:5px 16px;background:#95a5a6;color:#fff;';
    const close = () => {
        if (document.body.contains(overlay))
            document.body.removeChild(overlay);
    };
    const doCreate = async () => {
        const name = inp.value.trim();
        if (!name) {
            await orgModalAlert('ファイル名を入力してください');
            return;
        }
        close();
        void orgCreateFileInDropDir(name);
    };
    okBtn.addEventListener('click', doCreate);
    cancelBtn.addEventListener('click', close);
    inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            doCreate();
        }
        else if (e.key === 'Escape') {
            e.preventDefault();
            close();
        }
    });
    btnRow.appendChild(okBtn);
    btnRow.appendChild(cancelBtn);
    box.appendChild(p);
    box.appendChild(inp);
    box.appendChild(btnRow);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    setTimeout(() => inp.focus({ preventScroll: true }), 50);
}
/** 現在セクション内容に表示中のセクション（見出し行を含む）を編集する大きなモーダルを表示する。 */
async function orgShowSectionEditModal() {
    if (!fileSource.canReload()) {
        await orgModalAlert('ファイルが読み込まれていません');
        return;
    }
    if (orgSelectedCharPos === null || orgSelectedRange === null) {
        await orgModalAlert('アウトラインを選択してください');
        return;
    }
    const range = orgSelectedRange;
    const lines = orgOriginalContent.split('\n');
    const sectionText = lines.slice(range.start, range.end).join('\n');
    const overlay = document.createElement('div');
    overlay.className = 'text-bulk-overlay';
    const box = document.createElement('div');
    box.className = 'text-bulk-box';
    box.style.cssText = 'width:90vw;max-width:900px;max-height:85vh;display:flex;flex-direction:column;';
    const p = document.createElement('p');
    p.textContent = 'セクション内容を編集してください（見出し行を含みます。書式を保つとアウトライン構造が維持されます）:';
    const textarea = document.createElement('textarea');
    textarea.className = 'text-bulk-inp';
    textarea.value = sectionText;
    textarea.style.cssText = 'flex:1;min-height:60vh;resize:vertical;font-family:inherit;box-sizing:border-box;white-space:pre;';
    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;margin-top:8px;flex-shrink:0;';
    const okBtn = document.createElement('button');
    okBtn.className = 'btn btn-blue';
    okBtn.textContent = '保存';
    okBtn.style.padding = '5px 16px';
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn';
    cancelBtn.textContent = 'キャンセル';
    cancelBtn.style.cssText = 'padding:5px 16px;background:#95a5a6;color:#fff;';
    const close = () => {
        if (document.body.contains(overlay))
            document.body.removeChild(overlay);
    };
    const doSave = async () => {
        const newSectionText = textarea.value.replace(/\s+$/, '');
        const newSectionLines = newSectionText.length > 0 ? newSectionText.split('\n') : [];
        const newLines = [...lines.slice(0, range.start), ...newSectionLines, ...lines.slice(range.end)];
        const newContent = newLines.join('\n');
        const beforeLines = orgOriginalContent.split('\n').length;
        const beforeNB = orgCountNonBlank(orgOriginalContent);
        const afterLines = newContent.split('\n').length;
        const afterNB = orgCountNonBlank(newContent);
        const confirmed = await orgModalConfirm('セクション内容を書き換えます:\n\n' +
            '元ファイル: ' + beforeLines + '行 / 空白以外: ' + beforeNB + '行\n' +
            '変更後:     ' + afterLines + '行 / 空白以外: ' + afterNB + '行\n\n' +
            'OKを押すと上書き保存します。');
        if (!confirmed)
            return;
        const saved = await saveOrgContent(newContent);
        if (!saved)
            return;
        orgOriginalContent = newContent;
        const newOutlines = orgGetOutlines(orgOriginalContent);
        const sel = newOutlines.find(o => o.lineIndex === range.start);
        orgSelectedCharPos = sel ? sel.charPos : null;
        orgSelectedRange = orgSelectedCharPos !== null ? getOutlineSectionRange(orgOriginalContent, orgSelectedCharPos) : null;
        orgUpdateSectionCurrentHeading(sel ?? null);
        updateTotalLines(orgOriginalContent);
        orgRenderOutline(orgOriginalContent);
        orgShowSectionForSelected();
        close();
    };
    okBtn.addEventListener('click', () => { void doSave(); });
    cancelBtn.addEventListener('click', close);
    textarea.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            e.preventDefault();
            close();
        }
    });
    btnRow.appendChild(okBtn);
    btnRow.appendChild(cancelBtn);
    box.appendChild(p);
    box.appendChild(textarea);
    box.appendChild(btnRow);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    setTimeout(() => textarea.focus({ preventScroll: true }), 50);
}
/**
 * 任意のレベル・見出し・本文でアウトラインを追加するモーダルを表示する。
 * 左のアウトライン一覧で何も選択していなければファイルの先頭に、選択中ならそのアウトラインの下（末尾）に追加する。
 */
async function orgShowAppendUnsortedModal() {
    if (!fileSource.canReload()) {
        await orgModalAlert('ファイルを読み込んでください');
        return;
    }
    const selectedOutline = orgSelectedCharPos !== null
        ? orgGetOutlines(orgOriginalContent).find(o => o.charPos === orgSelectedCharPos)
        : undefined;
    const positionNote = selectedOutline
        ? `選択中のアウトライン「${selectedOutline.text}」の下に追加されます。`
        : 'アウトライン一覧で何も選択されていないため、ファイルの先頭に追加されます。';
    const overlay = document.createElement('div');
    overlay.className = 'text-bulk-overlay';
    const box = document.createElement('div');
    box.className = 'text-bulk-box';
    box.style.width = '480px';
    const p = document.createElement('p');
    p.textContent = `追加するアウトラインのレベル・見出し・本文を入力してください（${positionNote}）:`;
    const fieldRow = document.createElement('div');
    fieldRow.style.cssText = 'display:flex;gap:8px;align-items:center;margin-bottom:8px;';
    const levelLabel = document.createElement('label');
    levelLabel.textContent = 'レベル:';
    levelLabel.style.cssText = 'font-size:0.82rem;color:#9aa0a6;white-space:nowrap;';
    const levelInput = document.createElement('input');
    levelInput.type = 'number';
    levelInput.min = '1';
    levelInput.value = '2';
    levelInput.style.cssText = 'width:56px;';
    const titleLabel = document.createElement('label');
    titleLabel.textContent = '見出し:';
    titleLabel.style.cssText = 'font-size:0.82rem;color:#9aa0a6;white-space:nowrap;';
    const titleInput = document.createElement('input');
    titleInput.type = 'text';
    titleInput.value = '未整理';
    titleInput.style.cssText = 'flex:1;min-width:0;';
    fieldRow.appendChild(levelLabel);
    fieldRow.appendChild(levelInput);
    fieldRow.appendChild(titleLabel);
    fieldRow.appendChild(titleInput);
    const textarea = document.createElement('textarea');
    textarea.className = 'text-bulk-inp';
    textarea.rows = 12;
    textarea.style.cssText = 'width:100%;resize:vertical;font-family:inherit;box-sizing:border-box;';
    textarea.placeholder = '本文を入力（省略可）';
    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;margin-top:8px;';
    const okBtn = document.createElement('button');
    okBtn.className = 'btn btn-blue';
    okBtn.textContent = '追加';
    okBtn.style.padding = '5px 16px';
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn';
    cancelBtn.textContent = 'キャンセル';
    cancelBtn.style.cssText = 'padding:5px 16px;background:#95a5a6;color:#fff;';
    const close = () => {
        if (document.body.contains(overlay))
            document.body.removeChild(overlay);
    };
    const doAppend = async () => {
        const level = parseInt(levelInput.value, 10);
        if (!Number.isInteger(level) || level < 1) {
            await orgModalAlert('レベルは1以上の整数で入力してください');
            return;
        }
        const title = titleInput.value.trim();
        if (!title) {
            await orgModalAlert('見出しを入力してください');
            return;
        }
        const bodyText = textarea.value.replace(/\s+$/, '');
        const lines = orgOriginalContent.split('\n');
        let insertAt;
        let positionLabel;
        if (orgSelectedCharPos === null) {
            insertAt = 0;
            positionLabel = 'ファイルの先頭';
        }
        else {
            const range = getOutlineSectionRange(orgOriginalContent, orgSelectedCharPos);
            if (!range) {
                await orgModalAlert('選択中のアウトラインが見つかりませんでした（内容が変更された可能性があります）');
                return;
            }
            insertAt = range.end;
            positionLabel = `選択中のアウトライン「${selectedOutline?.text ?? ''}」の下`;
        }
        const headingLine = '*'.repeat(level) + ' ' + title;
        const newSectionLines = bodyText ? [headingLine, ...bodyText.split('\n')] : [headingLine];
        const prevLine = insertAt > 0 ? lines[insertAt - 1] : '';
        const nextLine = insertAt < lines.length ? lines[insertAt] : undefined;
        const toInsert = [];
        if (insertAt > 0 && prevLine.trim() !== '')
            toInsert.push('');
        toInsert.push(...newSectionLines);
        if (nextLine !== undefined && nextLine.trim() !== '')
            toInsert.push('');
        const newLines = [...lines.slice(0, insertAt), ...toInsert, ...lines.slice(insertAt)];
        const newContent = newLines.join('\n');
        const beforeLines = orgOriginalContent.split('\n').length;
        const beforeNB = orgCountNonBlank(orgOriginalContent);
        const afterLines = newContent.split('\n').length;
        const afterNB = orgCountNonBlank(newContent);
        const confirmed = await orgModalConfirm(`${positionLabel}に「${headingLine}」を追加します:\n\n` +
            '元ファイル: ' + beforeLines + '行 / 空白以外: ' + beforeNB + '行\n' +
            '追加後:     ' + afterLines + '行 / 空白以外: ' + afterNB + '行\n\n' +
            'OKを押すと上書き保存します。');
        if (!confirmed)
            return;
        const saved = await saveOrgContent(newContent);
        if (!saved)
            return;
        orgOriginalContent = newContent;
        updateTotalLines(orgOriginalContent);
        orgRenderOutline(orgOriginalContent);
        close();
    };
    okBtn.addEventListener('click', () => { void doAppend(); });
    cancelBtn.addEventListener('click', close);
    textarea.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            e.preventDefault();
            close();
        }
    });
    btnRow.appendChild(okBtn);
    btnRow.appendChild(cancelBtn);
    box.appendChild(p);
    box.appendChild(fieldRow);
    box.appendChild(textarea);
    box.appendChild(btnRow);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    setTimeout(() => titleInput.focus({ preventScroll: true }), 50);
}
/** 3つのタブ（セクション内容／ファイル一覧／アウトライン一覧）の active 表示を切り替える。 */
function orgSetRightTabActive(tabId) {
    ['org-tab-section', 'org-tab-filedrop', 'org-tab-outline2'].forEach(id => {
        document.getElementById(id)?.classList.toggle('active', id === tabId);
    });
}
/** ファイル一覧のUI状態に切り替える（フォルダ選択・スキャンは行わない）。 */
function orgShowFileDropListUI() {
    orgFileDropActive = true;
    orgOutline2Active = false;
    orgSetRightTabActive('org-tab-filedrop');
    document.getElementById('org-form2')?.classList.remove('outline2-list');
    document.getElementById('org-section-info')?.classList.add('hidden');
    document.getElementById('line-num-toggle-btn')?.classList.add('hidden');
    document.getElementById('section-card-mode-btn')?.classList.add('hidden');
    document.getElementById('section-edit-btn')?.classList.add('hidden');
    document.getElementById('outline2-collapse-all-btn')?.classList.add('hidden');
    document.getElementById('outline2-search-row')?.classList.add('hidden');
    orgUpdateSectionCurrentHeading(null);
    orgRenderFileDropList();
}
/**
 * 「アウトライン一覧」タブを表示中であれば、スクロール位置を保存した上で「セクション内容」タブの状態へ戻す。
 * （タブボタン以外の操作、例えば左のアウトライン一覧のクリックで離脱する場合に使う）
 */
function orgLeaveOutline2Tab() {
    if (!orgOutline2Active)
        return;
    const container = document.getElementById('org-form2');
    if (container)
        orgOutline2ScrollTop = container.scrollTop;
    orgOutline2Active = false;
    orgSetRightTabActive('org-tab-section');
    container?.classList.remove('outline2-list');
    document.getElementById('org-section-info')?.classList.remove('hidden');
    document.getElementById('line-num-toggle-btn')?.classList.remove('hidden');
    document.getElementById('section-card-mode-btn')?.classList.remove('hidden');
    document.getElementById('section-edit-btn')?.classList.remove('hidden');
    document.getElementById('outline2-collapse-all-btn')?.classList.add('hidden');
    document.getElementById('outline2-search-row')?.classList.add('hidden');
}
/** 「アウトライン一覧」タブのUI状態に切り替え、左のアウトライン一覧と同じ内容をミラー表示する。 */
function orgShowOutlineMirrorUI() {
    orgFileDropActive = false;
    orgOutline2Active = true;
    orgSetRightTabActive('org-tab-outline2');
    document.getElementById('org-form2')?.classList.remove('file-drop-list');
    document.getElementById('org-section-info')?.classList.add('hidden');
    document.getElementById('line-num-toggle-btn')?.classList.add('hidden');
    document.getElementById('section-card-mode-btn')?.classList.add('hidden');
    document.getElementById('section-edit-btn')?.classList.add('hidden');
    document.getElementById('outline2-collapse-all-btn')?.classList.remove('hidden');
    document.getElementById('outline2-search-row')?.classList.remove('hidden');
    orgUpdateSectionCurrentHeading(null);
    orgRenderOutlineMirrorList();
}
/**
 * 「アウトライン一覧」タブの中身を、左のアウトライン一覧と同じ内容でミラー表示する。
 * クリックでの選択・編集は行わず、ドラッグ&ドロップによる並べ替え専用の表示にする。
 */
function orgRenderOutlineMirrorList() {
    const container = document.getElementById('org-form2');
    container.classList.add('outline2-list');
    container.innerHTML = '';
    const outlines = orgGetOutlines(orgOriginalContent);
    if (outlines.length === 0) {
        const p = document.createElement('p');
        p.className = 'org-form-placeholder';
        p.textContent = 'アウトラインがありません';
        container.appendChild(p);
        return;
    }
    const visibility = orgComputeOutlineDisplayVisibility(outlines, orgOutline2CollapsedOutlines, orgOutline2SearchQuery);
    for (let i = 0; i < outlines.length; i++) {
        if (!visibility[i])
            continue;
        const item = outlines[i];
        const hasChildren = orgOutlineHasChildren(outlines, i);
        const div = document.createElement('div');
        div.className = 'org-outline-item lv' + Math.min(item.level, 4);
        div.title = item.text;
        div.dataset['charPos'] = String(item.charPos);
        if (item.charPos === orgSelectedCharPos || orgReorderSelectedOutlines.has(item.charPos)) {
            div.classList.add('selected');
        }
        const foldToggle = document.createElement('span');
        foldToggle.className = 'org-outline-fold-toggle' + (hasChildren ? '' : ' no-children');
        foldToggle.textContent = hasChildren ? (orgOutline2CollapsedOutlines.has(item.charPos) ? '▶' : '▼') : '';
        if (hasChildren) {
            foldToggle.addEventListener('click', (e) => {
                e.stopPropagation();
                orgOutline2ScrollTop = container.scrollTop; // 再描画で復元するスクロール位置をクリック時点のものに更新する
                orgOutline2CollapsedOutlines.has(item.charPos)
                    ? orgOutline2CollapsedOutlines.delete(item.charPos)
                    : orgOutline2CollapsedOutlines.add(item.charPos);
                orgRenderOutlineMirrorList();
            });
        }
        div.appendChild(foldToggle);
        const textSpan = document.createElement('span');
        textSpan.className = 'org-outline-item-text';
        textSpan.textContent = item.text;
        div.appendChild(textSpan);
        div.addEventListener('click', (e) => {
            if (e.ctrlKey || e.metaKey) {
                if (orgReorderSelectedOutlines.has(item.charPos)) {
                    orgReorderSelectedOutlines.delete(item.charPos);
                }
                else {
                    const lockedLevel = orgReorderSelectionLevel(outlines);
                    if (lockedLevel !== null && lockedLevel !== item.level) {
                        void orgModalAlert('複数選択できるのは同じレベルのアウトラインのみです');
                    }
                    else {
                        orgReorderSelectedOutlines.add(item.charPos);
                    }
                }
                orgApplyOutlineSelectionVisual();
                return;
            }
            orgReorderSelectedOutlines.clear();
            // 左のアウトライン一覧を、右（アウトライン一覧タブ）の展開状態・スクロール位置・選択に合わせた上で、
            // セクション内容タブへ切り替えて対応するセクションを表示する。
            const rightScrollTop = container.scrollTop;
            orgCollapsedOutlines = new Set(orgOutline2CollapsedOutlines);
            orgSelectedCharPos = item.charPos;
            const range = getOutlineSectionRange(orgOriginalContent, item.charPos);
            orgSelectedRange = range;
            orgUpdateSectionCurrentHeading(item);
            orgLeaveOutline2Tab();
            orgRenderOutline(orgOriginalContent);
            const leftListEl = document.getElementById('org-outline');
            if (leftListEl)
                leftListEl.scrollTop = rightScrollTop;
            const sectionContainer = document.getElementById('org-form2');
            if (range) {
                const lineCount = range.end - range.start;
                renderWithLineNumbers(sectionContainer, orgOriginalContent, {
                    showRange: range,
                    cardRanges: orgSectionCardModeActive
                        ? orgGetSectionCards(orgOriginalContent, range).map(c => ({ start: c.startLine, end: c.endLine }))
                        : undefined,
                });
                sectionContainer.scrollTop = 0;
                const infoEl = document.getElementById('org-section-info');
                if (infoEl)
                    infoEl.textContent = `${range.start + 1}〜${range.end}行（${lineCount}行）`;
            }
        });
        div.draggable = true;
        div.addEventListener('dragstart', (e) => {
            if (orgReorderSelectedOutlines.size > 0 && !orgReorderSelectedOutlines.has(item.charPos)) {
                orgReorderSelectedOutlines.clear();
                orgApplyOutlineSelectionVisual();
            }
            orgDraggedOutlineCharPositions = orgReorderSelectedOutlines.has(item.charPos)
                ? [...orgReorderSelectedOutlines]
                : [item.charPos];
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', '');
            const positions = orgDraggedOutlineCharPositions;
            document.querySelectorAll('.org-outline-item').forEach(itemEl => {
                if (positions.includes(Number(itemEl.dataset['charPos'])))
                    itemEl.classList.add('dragging');
            });
        });
        div.addEventListener('dragend', () => {
            orgDraggedOutlineCharPositions = null;
            document.querySelectorAll('.org-outline-item.dragging, .org-outline-item.drag-over').forEach(el => {
                el.classList.remove('dragging', 'drag-over');
            });
        });
        div.addEventListener('dragover', (e) => {
            if (orgDraggedOutlineCharPositions === null)
                return;
            e.preventDefault();
            div.classList.add('drag-over');
        });
        div.addEventListener('dragleave', () => div.classList.remove('drag-over'));
        div.addEventListener('drop', (e) => {
            if (orgDraggedOutlineCharPositions === null)
                return;
            e.preventDefault();
            e.stopPropagation();
            div.classList.remove('drag-over');
            void orgHandleOutlineReorderDrop(item.charPos);
        });
        container.appendChild(div);
    }
    if (orgOutline2SearchQuery.trim() && visibility.every(v => !v)) {
        const p = document.createElement('p');
        p.className = 'org-form-placeholder';
        p.textContent = '該当するアウトラインがありません';
        container.appendChild(p);
    }
    container.scrollTop = orgOutline2ScrollTop;
}
/** フォルダ選択ダイアログを開き、選択したフォルダの内容でファイル一覧を（再）読み込んで表示する。 */
async function orgActivateFileDropMode() {
    let dir;
    try {
        dir = await fileSource.pickDirectory();
    }
    catch (e) {
        await orgModalAlert(e instanceof Error ? e.message : String(e));
        return;
    }
    if (!dir)
        return;
    orgFileDropDir = dir;
    try {
        orgFileDropEntries = await fileSource.listOrgFiles(dir);
    }
    catch (e) {
        await orgModalAlert('フォルダの読み込みに失敗しました: ' + (e instanceof Error ? e.message : String(e)));
        return;
    }
    orgFileDropSearchQuery = '';
    orgShowFileDropListUI();
}
/** 「再読込」ボタン押下時の挙動。同じフォルダのファイル一覧を読み込み直す（他からファイルが追加された場合に反映するため）。 */
async function orgReloadFileDropList() {
    if (!orgFileDropDir)
        return;
    try {
        orgFileDropEntries = await fileSource.listOrgFiles(orgFileDropDir);
    }
    catch (e) {
        await orgModalAlert('フォルダの再読込に失敗しました: ' + (e instanceof Error ? e.message : String(e)));
        return;
    }
    orgRenderFileDropItems();
}
/**
 * 「ファイル一覧」タブ押下時の挙動。既にフォルダを選択済みなら、読み込み直さず同じファイル一覧をそのまま再表示する。
 * まだフォルダを選択していない場合のみ、フォルダ選択ダイアログを開く。
 */
async function orgOpenFileDropView() {
    if (orgFileDropDir) {
        orgShowFileDropListUI();
    }
    else {
        await orgActivateFileDropMode();
    }
}
/** 「セクション内容」タブに戻る（ファイル一覧・アウトライン一覧いずれの表示中でも呼び出せる）。読み込み済みのフォルダ・ファイル一覧は破棄しない。 */
function orgDeactivateFileDropMode() {
    orgFileDropActive = false;
    orgOutline2Active = false;
    orgFileDropItemsContainer = null;
    // ファイル振り分け中に複数選択していた場合は、セクション内容にはそのうち1件（先頭のもの）を表示する
    if (orgFileDropSelectedOutlines.size > 0) {
        orgSelectedCharPos = Math.min(...orgFileDropSelectedOutlines);
    }
    orgFileDropSelectedOutlines.clear();
    document.querySelectorAll('.org-outline-item').forEach(el => {
        const cp = Number(el.dataset['charPos']);
        el.classList.toggle('selected', cp === orgSelectedCharPos || orgReorderSelectedOutlines.has(cp));
    });
    orgSetRightTabActive('org-tab-section');
    document.getElementById('org-form2')?.classList.remove('file-drop-list', 'outline2-list');
    document.getElementById('org-section-info')?.classList.remove('hidden');
    document.getElementById('line-num-toggle-btn')?.classList.remove('hidden');
    document.getElementById('section-card-mode-btn')?.classList.remove('hidden');
    document.getElementById('section-edit-btn')?.classList.remove('hidden');
    document.getElementById('outline2-collapse-all-btn')?.classList.add('hidden');
    document.getElementById('outline2-search-row')?.classList.add('hidden');
    orgShowSectionForSelected();
}
/** ファイル一覧のファイルを右クリックした際の挙動: 確認の上でファイルパスを置き換える（"読込"ボタンと同じ状態にする）。 */
async function orgOpenFileDropEntry(entry) {
    const confirmed = await orgModalConfirm(`ファイルパスを「${entry.path}」に置き換えます。よろしいですか？`);
    if (!confirmed)
        return;
    if (!await orgLoadFromRef(entry.ref))
        return;
    orgAfterFileLoaded();
}
/** ファイル一覧で開いているフォルダのルートに、新規の .org ファイルを作成する。 */
async function orgCreateFileInDropDir(name) {
    if (!orgFileDropDir)
        return;
    if (!name) {
        await orgModalAlert('ファイル名を入力してください');
        return;
    }
    const fileName = `${name}.org`;
    let ref;
    try {
        ref = await fileSource.createFile(orgFileDropDir, fileName);
    }
    catch (e) {
        await orgModalAlert('ファイルの作成に失敗しました: ' + (e instanceof Error ? e.message : String(e)));
        return;
    }
    if (!orgFileDropEntries.some(e => e.path === fileName)) {
        orgFileDropEntries.push({ ref, path: fileName });
        orgFileDropEntries.sort((a, b) => a.path.localeCompare(b.path));
    }
    orgRenderFileDropItems();
    await orgModalAlert(`「${fileName}」を作成しました。`);
}
/**
 * セクション内容に表示されているカード（空行区切りのブロック）を、アウトライン一覧の
 * ドロップ先アウトラインの末尾へ移動する。同一ファイル内での移動であり、保存は1回のみ行う。
 */
async function orgHandleSectionCardDropOnOutline(targetItem, card) {
    orgDraggedSectionCard = null;
    if (!fileSource.canReload()) {
        await orgModalAlert('ファイルが読み込まれていません');
        return;
    }
    const lines = orgOriginalContent.split('\n');
    if (card.startLine < 0 || card.endLine > lines.length || card.startLine >= card.endLine) {
        await orgModalAlert('移動対象のカードが見つかりませんでした（内容が変更された可能性があります）');
        return;
    }
    const targetRange = getOutlineSectionRange(orgOriginalContent, targetItem.charPos);
    if (!targetRange) {
        await orgModalAlert('移動先のアウトラインが見つかりませんでした');
        return;
    }
    if (card.startLine >= targetRange.start && card.endLine === targetRange.end) {
        return; // 既にこのアウトラインの末尾にある
    }
    const cardLines = lines.slice(card.startLine, card.endLine);
    const cardText = cardLines.join('\n').trim();
    const withoutCard = [...lines.slice(0, card.startLine), ...lines.slice(card.endLine)];
    const removedCount = card.endLine - card.startLine;
    let insertAt = card.startLine < targetRange.end ? targetRange.end - removedCount : targetRange.end;
    insertAt = Math.max(0, Math.min(insertAt, withoutCard.length));
    const prevLine = insertAt > 0 ? withoutCard[insertAt - 1] : '';
    const nextLine = insertAt < withoutCard.length ? withoutCard[insertAt] : undefined;
    const toInsert = [];
    if (prevLine.trim() !== '')
        toInsert.push('');
    toInsert.push(...cardLines);
    if (nextLine !== undefined && nextLine.trim() !== '')
        toInsert.push('');
    const newLines = [...withoutCard.slice(0, insertAt), ...toInsert, ...withoutCard.slice(insertAt)];
    const newContent = newLines.join('\n');
    const m = targetItem.text.match(/^\*+\s+(.*)/);
    const targetTitle = m ? m[1].trim() : targetItem.text.trim();
    const beforeLines = orgOriginalContent.split('\n').length;
    const beforeNB = orgCountNonBlank(orgOriginalContent);
    const afterLines = newContent.split('\n').length;
    const afterNB = orgCountNonBlank(newContent);
    const confirmed = await orgModalConfirm(`カードを「${targetTitle}」の末尾へ移動します:\n\n` +
        'カード: ' + cardLines.length + '行 / 空白以外: ' + orgCountNonBlank(cardText) + '行\n\n' +
        '移動前: ' + beforeLines + '行 / 空白以外: ' + beforeNB + '行\n' +
        '移動後: ' + afterLines + '行 / 空白以外: ' + afterNB + '行\n\n' +
        'OKを押すと上書き保存します。');
    if (!confirmed)
        return;
    // この操作は見出し行自体を増減させないため、選択中アウトラインの「出現順」は不変。
    // 行数変化でずれる charPos/lineIndex ではなく、出現順（ordinal）で選択を復元する。
    const oldOutlines = orgGetOutlines(orgOriginalContent);
    const selOrdinal = orgSelectedCharPos !== null
        ? oldOutlines.findIndex(o => o.charPos === orgSelectedCharPos) : -1;
    const saved = await saveOrgContent(newContent);
    if (!saved)
        return;
    orgOriginalContent = newContent;
    if (selOrdinal >= 0) {
        const newOutlines = orgGetOutlines(orgOriginalContent);
        const sel = newOutlines[selOrdinal];
        orgSelectedCharPos = sel ? sel.charPos : null;
        orgSelectedRange = orgSelectedCharPos !== null
            ? getOutlineSectionRange(orgOriginalContent, orgSelectedCharPos) : null;
    }
    const container = document.getElementById('org-form2');
    const prevScrollTop = container?.scrollTop ?? 0;
    updateTotalLines(orgOriginalContent);
    orgRenderOutline(orgOriginalContent);
    orgShowSectionForSelected();
    // カードドラッグ後は先頭までスクロールし直さず、移動前のスクロール位置をできるだけ保つ
    if (container)
        container.scrollTop = prevScrollTop;
}
function orgFileDropBasename(path) {
    const name = path.split('/').pop() ?? path;
    return name.replace(/\.[^.]+$/, '');
}
/**
 * 複数の charPos が指すセクションをまとめて抽出する。
 * 親アウトラインとその子アウトラインを両方選択していた場合は、子側の範囲は親に含まれるため重複移動を避けて除外する。
 * 見つからなかった charPos は skippedCharPos に積んで呼び出し側へ知らせる。
 */
function orgExtractMultipleSections(content, charPositions) {
    const lines = content.split('\n');
    const outlines = orgGetOutlines(content);
    const withRange = [];
    const skippedCharPos = [];
    for (const cp of charPositions) {
        const outline = outlines.find(o => o.charPos === cp);
        const range = outline ? getOutlineSectionRange(content, cp) : null;
        if (!outline || !range) {
            skippedCharPos.push(cp);
            continue;
        }
        const m = outline.text.match(/^\*+\s+(.*)/);
        const title = m ? m[1].trim() : outline.text.trim();
        withRange.push({ range, title });
    }
    if (withRange.length === 0)
        return null;
    // 開始行でソートし、直前に採用した範囲に完全に含まれるもの（親を選んだ際の子）はスキップする
    withRange.sort((a, b) => a.range.start - b.range.start);
    const kept = [];
    for (const item of withRange) {
        const last = kept[kept.length - 1];
        if (last && item.range.start < last.range.end)
            continue;
        kept.push(item);
    }
    const sectionLines = [];
    for (const item of kept)
        sectionLines.push(...lines.slice(item.range.start, item.range.end));
    const excludedRanges = kept.map(k => k.range);
    const remainingLines = [];
    let idx = 0;
    for (let i = 0; i < lines.length; i++) {
        while (idx < excludedRanges.length && i >= excludedRanges[idx].end)
            idx++;
        const inExcluded = idx < excludedRanges.length && i >= excludedRanges[idx].start && i < excludedRanges[idx].end;
        if (!inExcluded)
            remainingLines.push(lines[i]);
    }
    while (remainingLines.length > 0 && remainingLines[remainingLines.length - 1].trim() === '')
        remainingLines.pop();
    remainingLines.push('');
    return { sectionLines, remaining: remainingLines.join('\n'), movedTitles: kept.map(k => k.title), skippedCharPos };
}
/**
 * ドラッグされたアウトライン（複数可）を、同一ファイル内でドロップ先のアウトラインの末尾
 * （そのアウトラインの子孫を含む範囲全体の直後）へ移動する。ファイル間移動と異なり、
 * 行の挿入・削除を伴わない単純な入れ替えのため、呼び出し側で行数が変化していないか検証すること。
 */
function orgReorderOutlineSections(content, draggedCharPositions, targetCharPos) {
    const lines = content.split('\n');
    const outlines = orgGetOutlines(content);
    const withRange = [];
    for (const cp of draggedCharPositions) {
        const outline = outlines.find(o => o.charPos === cp);
        if (!outline)
            continue;
        const range = getOutlineSectionRange(content, cp);
        if (!range)
            continue;
        const m = outline.text.match(/^\*+\s+(.*)/);
        withRange.push({ range, title: m ? m[1].trim() : outline.text.trim() });
    }
    if (withRange.length === 0) {
        return { errorMessage: '移動対象のアウトラインが見つかりませんでした（内容が変更された可能性があります）' };
    }
    const targetOutline = outlines.find(o => o.charPos === targetCharPos);
    if (!targetOutline) {
        return { errorMessage: '移動先のアウトラインが見つかりませんでした（内容が変更された可能性があります）' };
    }
    const targetInsideDragged = withRange.some(w => targetOutline.lineIndex >= w.range.start && targetOutline.lineIndex < w.range.end);
    if (targetInsideDragged) {
        return { errorMessage: '移動先に、移動しようとしているアウトライン自身が含まれています' };
    }
    // 開始行でソートし、直前に採用した範囲に完全に含まれるもの（親を選んだ際の子）はスキップする
    withRange.sort((a, b) => a.range.start - b.range.start);
    const kept = [];
    for (const item of withRange) {
        const last = kept[kept.length - 1];
        if (last && item.range.start < last.range.end)
            continue;
        kept.push(item);
    }
    const targetRange = getOutlineSectionRange(content, targetCharPos);
    const sectionLines = [];
    for (const item of kept)
        sectionLines.push(...lines.slice(item.range.start, item.range.end));
    const excludedRanges = kept.map(k => k.range);
    const withoutDragged = [];
    let idx = 0;
    let insertAt = -1;
    for (let i = 0; i < lines.length; i++) {
        while (idx < excludedRanges.length && i >= excludedRanges[idx].end)
            idx++;
        const inExcluded = idx < excludedRanges.length && i >= excludedRanges[idx].start && i < excludedRanges[idx].end;
        if (i === targetRange.end)
            insertAt = withoutDragged.length;
        if (!inExcluded)
            withoutDragged.push(lines[i]);
    }
    if (insertAt === -1)
        insertAt = withoutDragged.length; // 移動先がファイル末尾のアウトラインだった場合
    const newLines = [...withoutDragged.slice(0, insertAt), ...sectionLines, ...withoutDragged.slice(insertAt)];
    return { newContent: newLines.join('\n'), movedTitles: kept.map(k => k.title) };
}
/** アウトライン一覧同士（左のアウトライン一覧／ミラー表示の「アウトライン一覧」タブ）でのドラッグ&ドロップによる並べ替えを処理する。 */
async function orgHandleOutlineReorderDrop(targetCharPos) {
    const charPositions = orgDraggedOutlineCharPositions;
    orgDraggedOutlineCharPositions = null;
    if (charPositions === null || charPositions.length === 0)
        return;
    if (charPositions.includes(targetCharPos))
        return; // 自分自身へのドロップは無視
    if (!fileSource.canReload()) {
        await orgModalAlert('ファイルが読み込まれていません');
        return;
    }
    const result = orgReorderOutlineSections(orgOriginalContent, charPositions, targetCharPos);
    if ('errorMessage' in result) {
        await orgModalAlert(result.errorMessage);
        return;
    }
    const { newContent, movedTitles } = result;
    const beforeLines = orgOriginalContent.split('\n').length;
    const afterLines = newContent.split('\n').length;
    if (beforeLines !== afterLines) {
        await orgModalAlert('アウトラインの移動前後で行数が変化したため、処理を中止しました。\n' +
            `（変更前: ${beforeLines}行 → 変更後: ${afterLines}行）`);
        return;
    }
    const titleLabel = movedTitles.length === 1
        ? `アウトライン「${movedTitles[0]}」`
        : `アウトライン${movedTitles.length}件（${movedTitles.map(t => '「' + t + '」').join('、')}）`;
    const confirmed = await orgModalConfirm(`${titleLabel}を移動します。\n\n` +
        `変更前: ${beforeLines}行\n変更後: ${afterLines}行（変化なし）\n\n` +
        'OKを押すと上書き保存します。');
    if (!confirmed)
        return;
    const selectedText = orgSelectedCharPos !== null
        ? orgGetOutlines(orgOriginalContent).find(o => o.charPos === orgSelectedCharPos)?.text
        : undefined;
    const saved = await saveOrgContent(newContent);
    if (!saved)
        return;
    orgOriginalContent = newContent;
    if (selectedText !== undefined) {
        const newOutlines = orgGetOutlines(orgOriginalContent);
        const sel = newOutlines.find(o => o.text === selectedText);
        orgSelectedCharPos = sel ? sel.charPos : null;
        orgSelectedRange = orgSelectedCharPos !== null ? getOutlineSectionRange(orgOriginalContent, orgSelectedCharPos) : null;
    }
    else {
        orgSelectedCharPos = null;
        orgSelectedRange = null;
    }
    orgReorderSelectedOutlines.clear();
    updateTotalLines(orgOriginalContent);
    orgRenderOutline(orgOriginalContent);
    orgShowSectionForSelected(); // セクション内容表示中に並べ替えた場合、表示内容を追従させる
}
/** アウトライン移動の共通処理: 行数確認 → 対象ファイル書込 → 元ファイル保存 → 完了表示。charPositions が複数の場合はまとめて移動する。 */
async function orgPerformOutlineMove(charPositions, targetRef, targetPath, targetOriginal, isNewFile) {
    const extraction = orgExtractMultipleSections(orgOriginalContent, charPositions);
    if (!extraction || extraction.movedTitles.length === 0) {
        await orgModalAlert('選択したアウトラインが見つかりませんでした（内容が変更された可能性があります）');
        return;
    }
    const { sectionLines, remaining, movedTitles } = extraction;
    const separator = targetOriginal.trimEnd().length > 0 ? '\n\n' : '';
    const newTargetContent = targetOriginal.trimEnd() + separator + sectionLines.join('\n') + '\n';
    const beforeSourceLines = orgOriginalContent.split('\n').length;
    const beforeSourceNB = orgCountNonBlank(orgOriginalContent);
    const afterSourceLines = remaining.split('\n').length;
    const afterSourceNB = orgCountNonBlank(remaining);
    const beforeTargetLines = targetOriginal.split('\n').length;
    const beforeTargetNB = orgCountNonBlank(targetOriginal);
    const afterTargetLines = newTargetContent.split('\n').length;
    const afterTargetNB = orgCountNonBlank(newTargetContent);
    const titleLabel = movedTitles.length === 1
        ? `アウトライン「${movedTitles[0]}」`
        : `アウトライン${movedTitles.length}件（${movedTitles.map(t => '「' + t + '」').join('、')}）`;
    const confirmed = await orgModalConfirm(`${titleLabel}を「${targetPath}」へ移動します${isNewFile ? '（新規作成）' : ''}:\n\n` +
        '元ファイル:     ' + beforeSourceLines + '行 / 空白以外: ' + beforeSourceNB + '行\n' +
        '移動後:         ' + afterSourceLines + '行 / 空白以外: ' + afterSourceNB + '行\n\n' +
        '対象ファイル:   ' + beforeTargetLines + '行 / 空白以外: ' + beforeTargetNB + '行\n' +
        '追記後:         ' + afterTargetLines + '行 / 空白以外: ' + afterTargetNB + '行\n\n' +
        'OKを押すと両方のファイルを上書き保存します。');
    if (!confirmed)
        return;
    try {
        await fileSource.writeFile(targetRef, newTargetContent);
    }
    catch (e) {
        await orgModalAlert('対象ファイルの保存に失敗しました: ' + (e instanceof Error ? e.message : String(e)));
        return;
    }
    const sourceSaved = await saveOrgContent(remaining);
    if (!sourceSaved) {
        await orgModalAlert('元ファイルの保存に失敗しました。\n対象ファイルへの追記は完了していますが、元ファイルからの削除は反映されていません。');
        return;
    }
    orgOriginalContent = remaining;
    if (orgSelectedCharPos !== null && charPositions.includes(orgSelectedCharPos)) {
        orgSelectedCharPos = null;
        orgSelectedRange = null;
    }
    orgFileDropSelectedOutlines.clear();
    updateTotalLines(orgOriginalContent);
    orgRenderOutline(orgOriginalContent);
    if (isNewFile) {
        orgFileDropEntries.push({ ref: targetRef, path: targetPath });
        orgFileDropEntries.sort((a, b) => a.path.localeCompare(b.path));
        if (orgFileDropActive)
            orgRenderFileDropList();
    }
    await orgModalAlert('保存が完了しました。\n\n' +
        `元ファイル: ${afterSourceLines}行 / 空白以外: ${afterSourceNB}行\n` +
        `対象ファイル「${targetPath}」: ${afterTargetLines}行 / 空白以外: ${afterTargetNB}行`);
}
async function orgHandleOutlineDropOnFile(entry) {
    const charPositions = orgDraggedOutlineCharPositions;
    orgDraggedOutlineCharPositions = null;
    if (charPositions === null || charPositions.length === 0)
        return;
    if (!fileSource.canReload()) {
        await orgModalAlert('ファイルが読み込まれていません');
        return;
    }
    if (await fileSource.isCurrentFile(entry.ref)) {
        await orgModalAlert('移動先が現在開いているファイルと同じです。別のファイルを選択してください。');
        return;
    }
    let targetOriginal;
    try {
        targetOriginal = await fileSource.readFile(entry.ref);
    }
    catch (e) {
        await orgModalAlert('対象ファイルの読み込みに失敗しました: ' + (e instanceof Error ? e.message : String(e)));
        return;
    }
    await orgPerformOutlineMove(charPositions, entry.ref, entry.path, targetOriginal, false);
}
/** ファイル一覧の「ファイルが無い場所」へのドロップ: 同名ファイルへ移動、なければルートに新規作成。（複数選択時は名前一致の自動振り分けに対応しないため対象外） */
async function orgHandleOutlineDropOnEmptyArea() {
    const charPositions = orgDraggedOutlineCharPositions;
    orgDraggedOutlineCharPositions = null;
    if (charPositions === null || charPositions.length === 0)
        return;
    if (charPositions.length > 1) {
        await orgModalAlert('複数選択時は、名前が一致するファイルへの自動振り分けには対応していません。ファイル一覧の特定のファイルへ直接ドラッグしてください。');
        return;
    }
    const charPos = charPositions[0];
    if (!fileSource.canReload()) {
        await orgModalAlert('ファイルが読み込まれていません');
        return;
    }
    if (!orgFileDropDir)
        return;
    const outlines = orgGetOutlines(orgOriginalContent);
    const outline = outlines.find(o => o.charPos === charPos);
    if (!outline) {
        await orgModalAlert('選択したアウトラインが見つかりませんでした（内容が変更された可能性があります）');
        return;
    }
    const m = outline.text.match(/^\*+\s+(.*)/);
    const title = m ? m[1].trim() : outline.text.trim();
    const prefixMatch = title.match(/^(?:TODO|DONE)\s+(.+)$/);
    const lookupName = prefixMatch ? prefixMatch[1].trim() : title;
    const matches = orgFileDropEntries.filter(entry => orgFileDropBasename(entry.path) === lookupName);
    if (matches.length > 1) {
        await orgModalAlert(`「${lookupName}」という名前のファイルが複数のフォルダに見つかったため、処理対象外としました:\n\n` +
            matches.map(e => '・' + e.path).join('\n'));
        return;
    }
    if (matches.length === 1) {
        const entry = matches[0];
        if (await fileSource.isCurrentFile(entry.ref)) {
            await orgModalAlert('移動先が現在開いているファイルと同じです。');
            return;
        }
        let targetOriginal;
        try {
            targetOriginal = await fileSource.readFile(entry.ref);
        }
        catch (e) {
            await orgModalAlert('対象ファイルの読み込みに失敗しました: ' + (e instanceof Error ? e.message : String(e)));
            return;
        }
        await orgPerformOutlineMove([charPos], entry.ref, entry.path, targetOriginal, false);
        return;
    }
    const createOk = await orgModalConfirm(`「${lookupName}」という名前のファイルは見つかりませんでした。\n\n` +
        `選択したフォルダのルートに「${lookupName}.org」を新規作成して移動しますか？`);
    if (!createOk)
        return;
    let targetRef;
    try {
        targetRef = await fileSource.createFile(orgFileDropDir, `${lookupName}.org`);
    }
    catch (e) {
        await orgModalAlert('ファイルの作成に失敗しました: ' + (e instanceof Error ? e.message : String(e)));
        return;
    }
    await orgPerformOutlineMove([charPos], targetRef, `${lookupName}.org`, '', true);
}
// セクション内容／ファイル一覧／アウトライン一覧タブの切り替え
document.getElementById('org-tab-section').addEventListener('click', () => {
    if (orgFileDropActive || orgOutline2Active)
        orgDeactivateFileDropMode();
});
document.getElementById('org-tab-filedrop').addEventListener('click', () => {
    if (!orgFileDropActive)
        void orgOpenFileDropView();
});
document.getElementById('org-tab-outline2').addEventListener('click', () => {
    if (!orgOutline2Active)
        orgShowOutlineMirrorUI();
});
// ファイル一覧内の「ファイルが無い場所」へのドロップ（コンテナ要素は再利用されるため、リスナーは一度だけ登録する）
(() => {
    const container = document.getElementById('org-form2');
    const isOnFileOrHeader = (e) => {
        const target = e.target;
        return !!(target.closest('.file-drop-item') || target.closest('.file-drop-header'));
    };
    container.addEventListener('dragover', (e) => {
        if (!orgFileDropActive || orgDraggedOutlineCharPositions === null)
            return;
        if (isOnFileOrHeader(e))
            return;
        e.preventDefault();
        container.classList.add('file-drop-root-over');
    });
    container.addEventListener('dragleave', (e) => {
        if (!container.contains(e.relatedTarget))
            container.classList.remove('file-drop-root-over');
    });
    container.addEventListener('drop', (e) => {
        if (!orgFileDropActive || orgDraggedOutlineCharPositions === null)
            return;
        if (isOnFileOrHeader(e))
            return;
        e.preventDefault();
        container.classList.remove('file-drop-root-over');
        void orgHandleOutlineDropOnEmptyArea();
    });
})();
// ===== File save helper =====
async function saveOrgContent(content) {
    const rawPath = document.getElementById('org-file-path').value;
    const fileName = rawPath.replace(/["]/g, '').split(/[\\\/]/).pop() || 'output.org';
    try {
        await fileSource.save(content, fileName);
        return true;
    }
    catch (e) {
        await orgModalAlert('ファイルの保存に失敗しました: ' + (e instanceof Error ? e.message : String(e)));
        return false;
    }
}
/**
 * 現在選択中のアウトラインのセクションを削除し、指定したエクスポートテキストを
 * ファイル末尾に追加して保存する（「置換え」の中核処理）。確認ダイアログは呼び出し側で表示する。
 */
async function orgReplaceSelectedSectionWithExport(exportText) {
    if (!orgOriginalContent.trim() || orgSelectedCharPos === null)
        return false;
    const _outlines = orgGetOutlines(orgOriginalContent);
    const _selIdx = _outlines.findIndex(o => o.charPos === orgSelectedCharPos);
    const prevCharPos = _selIdx > 0 ? _outlines[_selIdx - 1].charPos : null;
    const range = getOutlineSectionRange(orgOriginalContent, orgSelectedCharPos);
    if (!range) {
        await orgModalAlert('元のアウトラインが見つかりません');
        return false;
    }
    const originalLines = orgOriginalContent.split('\n');
    const before = originalLines.slice(0, range.start);
    const after = originalLines.slice(range.end);
    const merged = [...before];
    while (merged.length > 0 && merged[merged.length - 1].trim() === '')
        merged.pop();
    if (after.length > 0)
        merged.push(...after);
    while (merged.length > 0 && merged[merged.length - 1].trim() === '')
        merged.pop();
    if (merged.length > 0)
        merged.push('');
    merged.push(...exportText.split('\n'));
    const newContent = merged.join('\n');
    const saved = await saveOrgContent(newContent);
    if (!saved)
        return false;
    orgOriginalContent = newContent;
    orgSelectedCharPos = prevCharPos;
    orgSelectedRange = null;
    updateTotalLines(orgOriginalContent);
    orgRenderOutline(orgOriginalContent);
    return true;
}
// ===== File pick and load =====
function orgApplyLoadedFile(loaded) {
    orgOriginalContent = loaded.content;
    const pathInput = document.getElementById('org-file-path');
    pathInput.value = loaded.name;
    pathInput.title = loaded.name;
    const fullEl = document.getElementById('org-path-full');
    if (fullEl) {
        fullEl.textContent = loaded.name;
        fullEl.style.display = loaded.name.length > 60 ? 'block' : 'none';
    }
}
async function orgPickAndLoad() {
    let loaded;
    try {
        loaded = await fileSource.pickAndLoad();
    }
    catch (e) {
        if (e instanceof Error && e.name !== 'AbortError')
            await orgModalAlert('ファイルの読み込みに失敗しました: ' + e.message);
        return false;
    }
    if (!loaded)
        return false;
    orgApplyLoadedFile(loaded);
    return true;
}
/** ファイル振り分けリストのファイル参照から、現在開いているファイルを閉じてそのファイルを開く。 */
async function orgLoadFromRef(ref) {
    let loaded;
    try {
        loaded = await fileSource.loadFromRef(ref);
    }
    catch (e) {
        await orgModalAlert('ファイルの読み込みに失敗しました: ' + (e instanceof Error ? e.message : String(e)));
        return false;
    }
    orgApplyLoadedFile(loaded);
    return true;
}
// ===== Org aggregate =====
/** 集約_n_ソートの中核処理: children を見出しテキストでグループ化し、ソートして本文行を組み立てる。 */
function orgBuildAggregatedLines(lines, children, scopeEndLine, prefixLines) {
    const groupMap = new Map();
    const order = [];
    for (let i = 0; i < children.length; i++) {
        const child = children[i];
        const header = lines[child.lineIndex];
        const nextEnd = i + 1 < children.length ? children[i + 1].lineIndex : scopeEndLine;
        const block = lines.slice(child.lineIndex + 1, nextEnd);
        if (!groupMap.has(header)) {
            groupMap.set(header, []);
            order.push(header);
        }
        groupMap.get(header).push(block);
    }
    const sortKey = (header) => {
        const title = (header.match(/^\*+ (.*)$/) ?? ['', header])[1];
        if (/^DONE/.test(title) || title === 'z' || title === 'j' || title === '除外' || title === '済み')
            return [0, title];
        if (/^TODO/.test(title))
            return [2, title];
        return [1, title];
    };
    order.sort((a, b) => {
        const [pa, ta] = sortKey(a);
        const [pb, tb] = sortKey(b);
        return pa !== pb ? pa - pb : ta.localeCompare(tb, 'ja');
    });
    const aggregated = [...prefixLines];
    for (const header of order) {
        const blocks = groupMap.get(header);
        aggregated.push(header);
        const trimmed = blocks.map(b => {
            let end = b.length;
            while (end > 0 && b[end - 1].trim() === '')
                end--;
            return b.slice(0, end);
        });
        for (let i = 0; i < trimmed.length; i++) {
            if (i > 0)
                aggregated.push('', '');
            aggregated.push(...trimmed[i]);
        }
        aggregated.push('', '');
    }
    return aggregated;
}
function orgAggregateContent(content, selectedCharPos) {
    const lines = content.split('\n');
    const outlines = orgGetOutlines(content);
    const selIdx = outlines.findIndex(o => o.charPos === selectedCharPos);
    if (selIdx === -1)
        return null;
    const sel = outlines[selIdx];
    const selLevel = sel.level;
    let scopeEndLine = lines.length;
    for (let i = selIdx + 1; i < outlines.length; i++) {
        if (outlines[i].level <= selLevel) {
            scopeEndLine = outlines[i].lineIndex;
            break;
        }
    }
    const children = outlines.filter(o => o.level === selLevel + 1 &&
        o.lineIndex > sel.lineIndex &&
        o.lineIndex < scopeEndLine);
    if (children.length === 0)
        return content;
    const firstChildLine = children[0].lineIndex;
    const prefixLines = lines.slice(sel.lineIndex, firstChildLine);
    const aggregated = orgBuildAggregatedLines(lines, children, scopeEndLine, prefixLines);
    const beforeScope = lines.slice(0, sel.lineIndex);
    const afterScope = lines.slice(scopeEndLine);
    return [...beforeScope, ...aggregated, ...afterScope].join('\n');
}
/**
 * アウトライン未選択時の集約_n_ソート。
 * レベル1（"*"）の見出しがファイル内に1つも無い場合、ファイル先頭が下位レベルの見出しから
 * 始まっているとみなし、実在する最も浅いレベルの見出しをファイル全体を対象に集約_n_ソートする。
 * レベル1の見出しが存在する場合は null を返す（呼び出し側でアウトライン選択を促す）。
 */
function orgAggregateContentImplicitRoot(content) {
    const lines = content.split('\n');
    const outlines = orgGetOutlines(content);
    if (outlines.length === 0)
        return null;
    if (outlines.some(o => o.level === 1))
        return null;
    const minLevel = Math.min(...outlines.map(o => o.level));
    const children = outlines.filter(o => o.level === minLevel);
    if (children.length === 0)
        return content;
    const scopeEndLine = lines.length;
    const firstChildLine = children[0].lineIndex;
    const prefixLines = lines.slice(0, firstChildLine);
    const aggregated = orgBuildAggregatedLines(lines, children, scopeEndLine, prefixLines);
    return aggregated.join('\n');
}
// ===== Outline/Section resize =====
(function initOrgSplitResize() {
    const leftEl = document.getElementById('org-split-left');
    const resizerEl = document.getElementById('org-split-resizer');
    const splitEl = resizerEl?.parentElement;
    if (!leftEl || !resizerEl || !splitEl)
        return;
    const saved = localStorage.getItem('memo-app-outline-width');
    if (saved)
        leftEl.style.flex = `0 0 ${saved}px`;
    let dragging = false;
    let startX = 0;
    let startWidth = 0;
    resizerEl.addEventListener('mousedown', (e) => {
        dragging = true;
        startX = e.clientX;
        startWidth = leftEl.offsetWidth;
        resizerEl.classList.add('dragging');
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
        e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
        if (!dragging)
            return;
        const newWidth = Math.max(50, Math.min(startWidth + (e.clientX - startX), splitEl.offsetWidth - 80));
        leftEl.style.flex = `0 0 ${newWidth}px`;
        localStorage.setItem('memo-app-outline-width', String(newWidth));
    });
    document.addEventListener('mouseup', () => {
        if (!dragging)
            return;
        dragging = false;
        resizerEl.classList.remove('dragging');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
    });
})();
// ===== Text mode column width resize =====
(function initTextColResize() {
    const resizerEl = document.getElementById('text-col-resizer');
    const panel = document.getElementById('text-mode-panel');
    if (!resizerEl || !panel)
        return;
    let currentWidth = 120;
    panel.style.setProperty('--text-cat-width', currentWidth + 'px');
    let dragging = false;
    let startX = 0;
    let startWidth = 0;
    resizerEl.addEventListener('mousedown', (e) => {
        dragging = true;
        startX = e.clientX;
        startWidth = currentWidth;
        resizerEl.classList.add('dragging');
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
        e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
        if (!dragging)
            return;
        const container = document.getElementById('text-rows-container');
        const maxW = container ? container.offsetWidth - 80 : 500;
        currentWidth = Math.max(50, Math.min(startWidth + (e.clientX - startX), maxW));
        panel.style.setProperty('--text-cat-width', currentWidth + 'px');
    });
    document.addEventListener('mouseup', () => {
        if (!dragging)
            return;
        dragging = false;
        resizerEl.classList.remove('dragging');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
    });
})();
// ===== Org file reload =====
function setReloadFileBtnEnabled(enabled) {
    const btn = document.getElementById('org-reload-file-btn');
    if (!btn)
        return;
    btn.disabled = !enabled;
    btn.style.opacity = enabled ? '1' : '0.4';
    btn.style.cursor = enabled ? 'pointer' : 'default';
}
function resizeOutlinePanel() {
    const filePanel = document.getElementById('org-file-panel');
    const content = document.getElementById('org-outline-content');
    if (!filePanel || !content || content.classList.contains('hidden'))
        return;
    const rect = filePanel.getBoundingClientRect();
    filePanel.style.height = Math.max(300, window.innerHeight - rect.top) + 'px';
}
function showTextPanel() {
    const textPanel = document.getElementById('text-mode-panel');
    const container = document.getElementById('text-rows-container');
    if (!textPanel || !container)
        return;
    textPanel.classList.remove('hidden');
    // Set to viewport height with border-box so total height = window.innerHeight.
    // This ensures the document is tall enough to scroll the outline panel off-screen.
    textPanel.style.boxSizing = 'border-box';
    textPanel.style.height = window.innerHeight + 'px';
    textPanel.style.display = 'flex';
    textPanel.style.flexDirection = 'column';
    // Container fills remaining space inside the flex panel
    container.style.flex = '1';
    container.style.minHeight = '0';
    container.style.maxHeight = 'none'; // override CSS max-height: 520px
    // Force layout then scroll so panel top lands at viewport top
    void textPanel.offsetHeight;
    const topPos = textPanel.getBoundingClientRect().top + window.scrollY;
    window.scrollTo(0, topPos);
    container.scrollTop = 0;
}
function hideTextPanel() {
    const textPanel = document.getElementById('text-mode-panel');
    const container = document.getElementById('text-rows-container');
    if (!textPanel || !container)
        return;
    textPanel.classList.add('hidden');
    textPanel.style.boxSizing = '';
    textPanel.style.height = '';
    textPanel.style.display = '';
    textPanel.style.flexDirection = '';
    container.style.flex = '';
    container.style.minHeight = '';
    container.style.maxHeight = '';
}
/** テキスト編集モードの表示中の内容をクリアし、エリア自体を非表示にしてアウトライン一覧表示に戻す。 */
function textClearAndReturnToOutline() {
    textRows = [];
    textSelectedIds.clear();
    textRenderRows();
    const lineCountEl = document.getElementById('text-content-linecount');
    if (lineCountEl)
        lineCountEl.textContent = '';
    hideTextPanel();
    showOutlinePanel();
}
function showGuiPanel() {
    const wrap = document.getElementById('gui-mode-panel');
    if (!wrap)
        return;
    wrap.classList.remove('hidden');
    wrap.style.height = window.innerHeight + 'px';
    // Force layout then scroll so panel top lands at viewport top
    void wrap.offsetHeight;
    const topPos = wrap.getBoundingClientRect().top + window.scrollY;
    window.scrollTo(0, topPos);
}
function hideGuiPanel() {
    const wrap = document.getElementById('gui-mode-panel');
    if (!wrap)
        return;
    wrap.classList.add('hidden');
    wrap.style.height = '';
}
function showOutlinePanel() {
    const filePanel = document.getElementById('org-file-panel');
    const content = document.getElementById('org-outline-content');
    if (!filePanel || !content)
        return;
    content.classList.remove('hidden');
    // Scroll file panel to viewport top instantly, then set height to fill rest of viewport
    filePanel.scrollIntoView({ behavior: 'instant' });
    resizeOutlinePanel();
}
async function orgReloadFile() {
    if (!fileSource.canReload())
        return;
    try {
        orgOriginalContent = await fileSource.reload();
    }
    catch (e) {
        await orgModalAlert('ファイルの再読み込みに失敗しました: ' + (e instanceof Error ? e.message : String(e)));
        return;
    }
    orgSelectedCharPos = null;
    orgSelectedRange = null;
    if (orgFileDropActive)
        orgDeactivateFileDropMode();
    orgUpdateSectionCurrentHeading(null);
    const container = document.getElementById('org-form2');
    container.innerHTML = '<p class="org-form-placeholder">アウトラインを選択するとセクション内容が表示されます</p>';
    const infoEl = document.getElementById('org-section-info');
    if (infoEl) {
        const lines = orgOriginalContent.split('\n').length;
        infoEl.textContent = `全${lines}行`;
    }
    updateTotalLines(orgOriginalContent);
    orgRenderOutline(orgOriginalContent);
}
// ===== TEXT MODE FUNCTIONS =====
function textGetMode() {
    return (document.querySelector('input[name="org-mode"]:checked')?.value) ?? 'text';
}
function textFitHeight(ta) {
    ta.style.height = 'auto';
    ta.style.height = ta.scrollHeight + 'px';
}
function textGetCandidates(q, excludeId) {
    const seen = new Set();
    const result = [];
    for (const row of textRows) {
        if (row.id === excludeId)
            continue;
        const v = row.outline.trim();
        if (v && !seen.has(v) && v.toLowerCase().includes(q.toLowerCase())) {
            seen.add(v);
            result.push(v);
        }
    }
    return result.sort((a, b) => a.localeCompare(b, 'ja'));
}
function textApplySelection() {
    document.querySelectorAll('.text-cat-input').forEach(inp => {
        const rowEl = inp.closest('.text-row');
        const rowId = rowEl?.dataset['rowId'] ?? '';
        inp.classList.toggle('text-cat-selected', textSelectedIds.has(rowId));
    });
}
const textAcEl = document.getElementById('text-ac-dropdown');
function textHideAC() {
    textAcEl.classList.add('hidden');
    textAcEl.innerHTML = '';
    textAcTarget = null;
    textAcActiveIdx = -1;
}
function textShowAC(inp, rowId) {
    const candidates = textGetCandidates(inp.value, rowId);
    if (candidates.length === 0 || candidates.includes(inp.value.trim())) {
        textHideAC();
        return;
    }
    textAcTarget = inp;
    textAcActiveIdx = -1;
    textAcEl.innerHTML = '';
    for (const c of candidates) {
        const item = document.createElement('div');
        item.className = 'text-ac-item';
        item.textContent = c;
        item.addEventListener('mousedown', (e) => {
            e.preventDefault();
            inp.value = c;
            const row = textRows.find(r => r.id === rowId);
            if (row)
                row.outline = c;
            textHideAC();
        });
        textAcEl.appendChild(item);
    }
    const rect = inp.getBoundingClientRect();
    textAcEl.style.left = rect.left + 'px';
    textAcEl.style.top = (rect.bottom + 2) + 'px';
    textAcEl.style.minWidth = rect.width + 'px';
    textAcEl.classList.remove('hidden');
}
function textBuildRow(row) {
    const rowEl = document.createElement('div');
    rowEl.className = 'text-row';
    rowEl.dataset['rowId'] = row.id;
    const catInp = document.createElement('input');
    catInp.type = 'text';
    catInp.className = 'text-cat-input';
    catInp.value = row.outline;
    catInp.placeholder = textDefaultOutline || '未整理';
    catInp.autocomplete = 'off';
    catInp.spellcheck = false;
    catInp.addEventListener('input', () => {
        row.outline = catInp.value;
        // 入力していた内容を全て消去した場合は一覧を表示しない（ArrowDownでの明示的な一覧表示は従来通り）
        if (!catInp.value.trim()) {
            textHideAC();
            return;
        }
        textShowAC(catInp, row.id);
    });
    catInp.addEventListener('blur', () => setTimeout(textHideAC, 150));
    catInp.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            textHideAC();
            return;
        }
        if (e.key === 'ArrowDown' && textAcEl.classList.contains('hidden')) {
            e.preventDefault();
            textShowAC(catInp, row.id);
            return;
        }
        if (!textAcEl.classList.contains('hidden') && textAcTarget === catInp) {
            const items = textAcEl.querySelectorAll('.text-ac-item');
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                textAcActiveIdx = Math.min(textAcActiveIdx + 1, items.length - 1);
                items.forEach((it, i) => it.classList.toggle('active', i === textAcActiveIdx));
            }
            else if (e.key === 'ArrowUp') {
                e.preventDefault();
                textAcActiveIdx = Math.max(textAcActiveIdx - 1, -1);
                items.forEach((it, i) => it.classList.toggle('active', i === textAcActiveIdx));
            }
            else if (e.key === 'Enter') {
                e.preventDefault();
                if (textAcActiveIdx >= 0) {
                    catInp.value = items[textAcActiveIdx].textContent ?? '';
                    row.outline = catInp.value;
                }
                textHideAC();
            }
        }
    });
    const contentArea = document.createElement('textarea');
    contentArea.className = 'text-content-area';
    contentArea.value = row.content;
    contentArea.rows = 1;
    contentArea.addEventListener('input', () => {
        row.content = contentArea.value;
        textFitHeight(contentArea);
    });
    contentArea.addEventListener('focus', () => textHideAC());
    rowEl.appendChild(catInp);
    rowEl.appendChild(contentArea);
    return rowEl;
}
function textRenderRows() {
    const container = document.getElementById('text-rows-container');
    container.innerHTML = '';
    for (const row of textRows)
        container.appendChild(textBuildRow(row));
    requestAnimationFrame(() => {
        container.querySelectorAll('.text-content-area').forEach(textFitHeight);
    });
}
function textSort() {
    textRows.sort((a, b) => {
        const na = a.outline.trim() || '未整理';
        const nb = b.outline.trim() || '未整理';
        if (na === '未整理' && nb !== '未整理')
            return 1;
        if (na !== '未整理' && nb === '未整理')
            return -1;
        return na.localeCompare(nb, 'ja');
    });
    textRenderRows();
}
/** 内容でソートする（アウトライン欄は無視して、内容の文字列順に並び替える）。 */
function textSortByContent() {
    textRows.sort((a, b) => a.content.trim().localeCompare(b.content.trim(), 'ja'));
    textRenderRows();
}
function textGenerateExport(rows = textRows) {
    const grouped = new Map();
    const order = [];
    for (const row of rows) {
        const name = row.outline.trim() || textDefaultOutline || '未整理';
        if (!grouped.has(name)) {
            grouped.set(name, []);
            order.push(name);
        }
        const content = row.content.trim();
        if (content)
            grouped.get(name).push(content);
    }
    order.sort((a, b) => {
        if (a === '未整理')
            return 1;
        if (b === '未整理')
            return -1;
        return a.localeCompare(b, 'ja');
    });
    const sections = [];
    for (const name of order) {
        const contents = grouped.get(name) ?? [];
        if (contents.length === 0)
            continue;
        sections.push('** ' + name + '\n' + contents.join('\n\n\n'));
    }
    return sections.join('\n\n');
}
/** 確認ダイアログ表示用に、内容を1行・一定文字数に要約する。 */
function orgSummarizeContent(text, maxLen = 50) {
    const oneLine = text.trim().replace(/\s*\n\s*/g, ' / ');
    return oneLine.length > maxLen ? oneLine.slice(0, maxLen) + '…' : oneLine;
}
/**
 * 内容が完全一致するカードを重複とみなし、1件を残して削除する対象を選び出す。
 * 出現順で最初の1件を残し、以降の同一内容を重複として返す。
 */
function textFindDuplicateRows() {
    const seen = new Set();
    const kept = [];
    const duplicates = [];
    for (const row of textRows) {
        const key = row.content.trim();
        if (key && seen.has(key)) {
            duplicates.push(row);
        }
        else {
            if (key)
                seen.add(key);
            kept.push(row);
        }
    }
    return { kept, duplicates };
}
/** 重複するカード（内容が完全一致するもの）を1件残して削除し、ファイルへ保存する。 */
async function textApplyDedup() {
    if (!orgOriginalContent.trim()) {
        await orgModalAlert('ファイルを読み込んでください');
        return;
    }
    if (orgSelectedCharPos === null) {
        await orgModalAlert('アウトラインを選択してください');
        return;
    }
    const { kept, duplicates } = textFindDuplicateRows();
    if (duplicates.length === 0) {
        await orgModalAlert('重複するカードはありませんでした。');
        return;
    }
    const exportTextAfter = textGenerateExport(kept);
    const afterLines = exportTextAfter.split('\n').length;
    const afterNB = orgCountNonBlank(exportTextAfter);
    const dupList = duplicates.map(d => '・' + orgSummarizeContent(d.content)).join('\n');
    const confirmed = await orgModalConfirm(`内容が完全に一致するカードが${duplicates.length}件見つかりました。1件を残し、残りを削除します:\n\n` +
        dupList + '\n\n' +
        `削除後のExport行数: ${afterLines}行 / 空白以外: ${afterNB}行\n\n` +
        'OKを押すと重複を削除し、ファイルへ上書き保存します。');
    if (!confirmed)
        return;
    textRows = kept;
    textSelectedIds.clear();
    textRenderRows();
    const saved = await orgReplaceSelectedSectionWithExport(exportTextAfter);
    if (!saved)
        return;
    orgShowSectionForSelected();
    textClearAndReturnToOutline();
}
// ===== Text mode: rule-based outline auto-fill =====
// ルール1: 内容の末尾がこれらのいずれかで終わっていれば「TODO」を設定する（大文字小文字を無視）
const TEXT_RULE1_ENDING_RE = /(だろうか|[?？]|だっけ|たい|たいかも|出来ないか)\s*$/i;
/** TODO/DONE の接頭辞を除いた名前を返す（接頭辞が無ければそのまま）。 */
function textStripTodoDonePrefix(title) {
    const m = title.trim().match(/^(?:TODO|DONE)\s+(.+)$/);
    return (m ? m[1] : title).trim();
}
/** 「分解」実行時に選択されていた、現在編集中のアウトライン名（TODO/DONE接頭辞は除いたもの）。 */
function textCurrentEditingOutlineName() {
    return textStripTodoDonePrefix(textDefaultOutline);
}
/**
 * ルール2で使う候補一覧を、ファイル内のアウトライン一覧から構築する（ファイル出現順）。
 * 現在編集中のアウトライン（分解時に選択したアウトライン）自身は候補から除外する。
 */
function textBuildOutlineCandidates(minLen) {
    const excludeName = textCurrentEditingOutlineName();
    const outlines = orgGetOutlines(orgOriginalContent);
    const candidates = [];
    for (const o of outlines) {
        const m = o.text.match(/^\*+\s+(.*)/);
        const title = (m ? m[1] : o.text).trim();
        if (!title)
            continue;
        const prefixMatch = title.match(/^(?:TODO|DONE)\s+(.+)$/);
        const name = (prefixMatch ? prefixMatch[1] : title).trim();
        if (!name || name === excludeName)
            continue;
        if (name.length < minLen)
            continue;
        const searchKey = prefixMatch ? ` ${name} ` : name;
        candidates.push({ searchKey, name });
    }
    return candidates;
}
function textCountOccurrences(haystack, needle) {
    if (!needle)
        return 0;
    let count = 0;
    let idx = 0;
    for (;;) {
        const found = haystack.indexOf(needle, idx);
        if (found === -1)
            break;
        count++;
        idx = found + needle.length;
    }
    return count;
}
/** 大文字小文字の違いを無視して内容中の登場回数を数える。 */
function textCountOccurrencesCI(haystack, needle) {
    return textCountOccurrences(haystack.toLowerCase(), needle.toLowerCase());
}
/**
 * ルール2: 内容に登場する候補の中から最適な1件を選ぶ（検索は大文字小文字の違いを無視する）。
 * アウトライン欄に設定する値は、アウトライン一覧の文字列をそのまま（大文字小文字を変更せず）使う。
 * 優先順位: 一致文字列が長いもの → 登場回数が多いもの。
 * 文字列の長さ・登場回数がともに同じ候補が複数ある場合（＝どちらとも決められない場合）は設定しない（null）。
 */
function textFindBestOutlineMatch(content, candidates) {
    let best = null;
    let tied = false;
    for (const cand of candidates) {
        const count = textCountOccurrencesCI(content, cand.searchKey);
        if (count === 0)
            continue;
        const length = cand.name.length;
        if (!best || length > best.length || (length === best.length && count > best.count)) {
            best = { name: cand.name, length, count };
            tied = false;
        }
        else if (length === best.length && count === best.count && cand.name !== best.name) {
            tied = true;
        }
    }
    return (best && !tied) ? best.name : null;
}
function textGetRuleMinLen() {
    const inp = document.getElementById('text-rule-minlen');
    const v = parseInt(inp?.value ?? '5', 10);
    return Number.isFinite(v) && v > 0 ? v : 5;
}
/** ルール1: アウトライン欄が空欄の行のうち、内容の末尾が指定パターンのものに「TODO」を設定する。 */
async function textApplyRule1() {
    let changed = 0;
    for (const row of textRows) {
        if (row.outline.trim())
            continue; // 既に値がある行は上書きしない
        if (TEXT_RULE1_ENDING_RE.test(row.content.trim())) {
            row.outline = 'TODO';
            changed++;
        }
    }
    textRenderRows();
    await orgModalAlert(`TODO設定を行いました。${changed}件のアウトライン欄を設定しました。`);
}
/** ルール2: アウトライン欄が空欄の行のうち、内容にファイル内のアウトライン名が登場するものへ、その名前を設定する。 */
async function textApplyRule2() {
    const minLen = textGetRuleMinLen();
    const candidates = textBuildOutlineCandidates(minLen);
    let changed = 0;
    for (const row of textRows) {
        if (row.outline.trim())
            continue; // 既に値がある行は上書きしない
        const matched = textFindBestOutlineMatch(row.content, candidates);
        if (matched) {
            row.outline = matched;
            changed++;
        }
    }
    textRenderRows();
    await orgModalAlert(`一致アウトライン設定を行いました。${changed}件のアウトライン欄を設定しました。`);
}
/** 既にアウトライン欄に値が設定されている行に対し、「TODO 」を先頭に追記する（既にTODO/DONE付きの行は対象外）。 */
async function textApplyTodoPrefix() {
    let changed = 0;
    for (const row of textRows) {
        const v = row.outline.trim();
        if (!v)
            continue; // 空欄の行は対象外
        if (/^(?:TODO|DONE)\s/.test(v))
            continue; // 既にTODO/DONEが付いている行は対象外
        row.outline = `TODO ${v}`;
        changed++;
    }
    textRenderRows();
    await orgModalAlert(`TODO付与を行いました。${changed}件のアウトライン欄を設定しました。`);
}
function textShowBulkPopup() {
    if (textSelectedIds.size === 0)
        return;
    const overlay = document.createElement('div');
    overlay.className = 'text-bulk-overlay';
    const box = document.createElement('div');
    box.className = 'text-bulk-box';
    const p = document.createElement('p');
    p.textContent = textSelectedIds.size + '件のアウトライン名を一括設定:';
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.className = 'text-bulk-inp';
    inp.placeholder = 'アウトライン名';
    inp.autocomplete = 'off';
    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;margin-top:8px;';
    const okBtn = document.createElement('button');
    okBtn.className = 'btn btn-blue';
    okBtn.textContent = '適用';
    okBtn.style.padding = '5px 16px';
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn';
    cancelBtn.textContent = 'キャンセル';
    cancelBtn.style.cssText = 'padding:5px 16px;background:#95a5a6;color:#fff;';
    // 入力欄ラッパー（ドロップダウンをabsoluteで内包）
    const inpWrap = document.createElement('div');
    inpWrap.style.cssText = 'position:relative;';
    // ドロップダウン（ラッパー内でabsolute配置）
    const dropEl = document.createElement('div');
    dropEl.className = 'text-ac-dropdown text-bulk-dropdown';
    dropEl.style.display = 'none';
    const allOutlines = [...new Set(textRows.map(r => r.outline.trim()).filter(v => v))].sort((a, b) => a.localeCompare(b, 'ja'));
    const showDrop = (filter) => {
        if (allOutlines.includes(filter.trim())) {
            dropEl.style.display = 'none';
            return;
        }
        const filtered = filter
            ? allOutlines.filter(v => v.toLowerCase().includes(filter.toLowerCase()))
            : allOutlines;
        if (filtered.length === 0) {
            dropEl.style.display = 'none';
            return;
        }
        dropEl.innerHTML = '';
        filtered.forEach(name => {
            const item = document.createElement('div');
            item.className = 'text-ac-item';
            item.textContent = name;
            item.tabIndex = 0;
            item.addEventListener('focus', () => {
                dropEl.querySelectorAll('.text-ac-item').forEach(i => i.classList.remove('active'));
                item.classList.add('active');
            });
            item.addEventListener('blur', () => item.classList.remove('active'));
            item.addEventListener('mousedown', (e) => {
                e.preventDefault();
                inp.value = name;
                dropEl.style.display = 'none';
                inp.focus();
            });
            item.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    inp.value = name;
                    dropEl.style.display = 'none';
                    inp.focus();
                }
                else if (e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey)) {
                    e.preventDefault();
                    const next = item.nextElementSibling;
                    (next ?? dropEl.firstElementChild)?.focus();
                }
                else if (e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey)) {
                    e.preventDefault();
                    const prev = item.previousElementSibling;
                    if (prev)
                        prev.focus();
                    else
                        inp.focus();
                }
                else if (e.key === 'Escape') {
                    dropEl.style.display = 'none';
                    inp.focus();
                }
            });
            item.addEventListener('blur', () => setTimeout(() => {
                if (document.activeElement !== inp && !dropEl.contains(document.activeElement)) {
                    dropEl.style.display = 'none';
                }
            }, 150));
            dropEl.appendChild(item);
        });
        dropEl.style.display = '';
    };
    const hideDrop = () => { dropEl.style.display = 'none'; };
    const close = () => {
        if (document.body.contains(overlay))
            document.body.removeChild(overlay);
    };
    const findNextCatInput = () => {
        const container = document.getElementById('text-rows-container');
        if (!container)
            return null;
        const allRows = Array.from(container.querySelectorAll('.text-row'));
        let lastIdx = -1;
        for (let i = 0; i < allRows.length; i++) {
            if (textSelectedIds.has(allRows[i].dataset['rowId'] ?? ''))
                lastIdx = i;
        }
        if (lastIdx < 0 || lastIdx >= allRows.length - 1)
            return null;
        return allRows[lastIdx + 1].querySelector('.text-cat-input');
    };
    const doApplyFinal = () => {
        const next = findNextCatInput();
        const val = inp.value.trim();
        for (const id of textSelectedIds) {
            const row = textRows.find(r => r.id === id);
            if (!row)
                continue;
            row.outline = val;
            const rowEl = document.querySelector(`.text-row[data-row-id="${id}"]`);
            const catInp = rowEl?.querySelector('.text-cat-input');
            if (catInp)
                catInp.value = val;
        }
        textSelectedIds.clear();
        textApplySelection();
        close();
        if (next)
            next.focus();
    };
    inp.addEventListener('input', () => showDrop(inp.value));
    inp.addEventListener('blur', () => setTimeout(() => {
        if (!dropEl.contains(document.activeElement))
            hideDrop();
    }, 150));
    inp.addEventListener('keydown', (e) => {
        if (e.key === 'Tab' && !e.shiftKey && dropEl.style.display !== 'none') {
            e.preventDefault();
            dropEl.firstElementChild?.focus();
        }
        else if (e.key === 'Enter') {
            hideDrop();
            doApplyFinal();
        }
        else if (e.key === 'Escape') {
            const next = findNextCatInput();
            textSelectedIds.clear();
            textApplySelection();
            close();
            if (next)
                next.focus();
        }
    });
    inpWrap.appendChild(inp);
    inpWrap.appendChild(dropEl);
    okBtn.addEventListener('click', doApplyFinal);
    cancelBtn.addEventListener('click', () => {
        const next = findNextCatInput();
        textSelectedIds.clear();
        textApplySelection();
        close();
        if (next)
            next.focus();
    });
    btnRow.appendChild(okBtn);
    btnRow.appendChild(cancelBtn);
    box.appendChild(p);
    box.appendChild(inpWrap);
    box.appendChild(btnRow);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    setTimeout(() => inp.focus({ preventScroll: true }), 50);
}
// テキストモード補完ドロップダウンのスクロール追従
(function initTextAcScrollSync() {
    const container = document.getElementById('text-rows-container');
    if (!container)
        return;
    container.addEventListener('scroll', () => {
        if (textAcEl.classList.contains('hidden') || !textAcTarget)
            return;
        const rect = textAcTarget.getBoundingClientRect();
        textAcEl.style.left = rect.left + 'px';
        textAcEl.style.top = (rect.bottom + 2) + 'px';
    }, { passive: true });
})();
// ===== Text mode rubber-band =====
(function initTextRubberBand() {
    const selBox = document.getElementById('text-sel-box');
    let active = false;
    let docStartX = 0, docStartY = 0;
    let lastClientX = 0, lastClientY = 0, lastCtrl = false;
    function applyRubberBand(clientX, clientY, ctrlOrMeta) {
        lastClientX = clientX;
        lastClientY = clientY;
        lastCtrl = ctrlOrMeta;
        const docX = clientX + window.scrollX;
        const docY = clientY + window.scrollY;
        const x = Math.min(docX, docStartX);
        const y = Math.min(docY, docStartY);
        const w = Math.abs(docX - docStartX);
        const h = Math.abs(docY - docStartY);
        // selBox は position:fixed なのでビューポート座標に戻す
        selBox.style.left = (x - window.scrollX) + 'px';
        selBox.style.top = (y - window.scrollY) + 'px';
        selBox.style.width = w + 'px';
        selBox.style.height = h + 'px';
        document.querySelectorAll('.text-cat-input').forEach(inp => {
            const r = inp.getBoundingClientRect();
            const el = r.left + window.scrollX, er = r.right + window.scrollX;
            const et = r.top + window.scrollY, eb = r.bottom + window.scrollY;
            const overlaps = !(x + w < el || x > er || y + h < et || y > eb);
            const rowEl = inp.closest('.text-row');
            const rowId = rowEl?.dataset['rowId'] ?? '';
            if (overlaps)
                textSelectedIds.add(rowId);
            else if (!ctrlOrMeta)
                textSelectedIds.delete(rowId);
        });
        textApplySelection();
    }
    document.addEventListener('mousedown', (e) => {
        if (e.button !== 0)
            return;
        const target = e.target;
        if (!target.closest('#text-mode-panel'))
            return;
        if (target.closest('input') || target.closest('.text-content-area') || target.closest('button'))
            return;
        active = true;
        docStartX = e.clientX + window.scrollX;
        docStartY = e.clientY + window.scrollY;
        selBox.style.cssText = `left:${e.clientX}px;top:${e.clientY}px;width:0;height:0;display:block;`;
        if (!e.ctrlKey && !e.metaKey) {
            textSelectedIds.clear();
            textApplySelection();
        }
        e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
        if (!active)
            return;
        applyRubberBand(e.clientX, e.clientY, e.ctrlKey || e.metaKey);
    });
    window.addEventListener('scroll', () => {
        if (!active)
            return;
        applyRubberBand(lastClientX, lastClientY, lastCtrl);
    }, { passive: true });
    document.addEventListener('mouseup', (e) => {
        if (!active)
            return;
        active = false;
        selBox.style.display = 'none';
        const w = Math.abs(e.clientX + window.scrollX - docStartX);
        const h = Math.abs(e.clientY + window.scrollY - docStartY);
        if ((w > 5 || h > 5) && textSelectedIds.size > 0)
            textShowBulkPopup();
    });
})();
// ===== Text mode Tab navigation =====
// Order: アウトライン[0..n] → ソート → 置き換え → 内容[0..n] → (wrap)
document.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab')
        return;
    const target = e.target;
    const isCat = target.classList.contains('text-cat-input');
    const isContent = target.classList.contains('text-content-area');
    const isSortBtn = target.id === 'text-sort-btn';
    const isExportBtn = target.id === 'text-export-btn';
    if (!isCat && !isContent && !isSortBtn && !isExportBtn)
        return;
    e.preventDefault();
    const catInputs = Array.from(document.querySelectorAll('.text-cat-input'));
    const contentAreas = Array.from(document.querySelectorAll('.text-content-area'));
    const sortBtn = document.getElementById('text-sort-btn');
    const exportBtn = document.getElementById('text-export-btn');
    if (!e.shiftKey) {
        if (isCat) {
            const idx = catInputs.indexOf(target);
            if (idx < catInputs.length - 1) {
                const next = catInputs[idx + 1];
                const container = document.getElementById('text-rows-container');
                if (container) {
                    const cRect = container.getBoundingClientRect();
                    const nRect = next.getBoundingClientRect();
                    const needsScroll = nRect.bottom > cRect.bottom;
                    const offsetInContainer = nRect.top - cRect.top + container.scrollTop;
                    next.focus({ preventScroll: true });
                    if (needsScroll)
                        container.scrollTop = offsetInContainer - 60;
                }
                else {
                    next.focus();
                }
            }
            else
                sortBtn?.focus();
        }
        else if (isSortBtn) {
            exportBtn?.focus();
        }
        else if (isExportBtn) {
            contentAreas[0]?.focus();
        }
        else {
            const idx = contentAreas.indexOf(target);
            if (idx < contentAreas.length - 1)
                contentAreas[idx + 1].focus();
            else
                catInputs[0]?.focus();
        }
    }
    else {
        if (isContent) {
            const idx = contentAreas.indexOf(target);
            if (idx > 0)
                contentAreas[idx - 1].focus();
            else
                exportBtn?.focus();
        }
        else if (isExportBtn) {
            sortBtn?.focus();
        }
        else if (isSortBtn) {
            catInputs[catInputs.length - 1]?.focus();
        }
        else {
            const idx = catInputs.indexOf(target);
            if (idx > 0) {
                const prev = catInputs[idx - 1];
                const container = document.getElementById('text-rows-container');
                if (container) {
                    const cRect = container.getBoundingClientRect();
                    const pRect = prev.getBoundingClientRect();
                    const needsScroll = pRect.top < cRect.top;
                    const offsetInContainer = pRect.top - cRect.top + container.scrollTop;
                    prev.focus({ preventScroll: true });
                    if (needsScroll)
                        container.scrollTop = offsetInContainer - (container.clientHeight - 60);
                }
                else {
                    prev.focus();
                }
            }
            else
                contentAreas[contentAreas.length - 1]?.focus();
        }
    }
}, true);
// Ctrl+B → 分解ボタン
document.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.key !== 'b')
        return;
    const target = e.target;
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
        return;
    e.preventDefault();
    document.getElementById('process-btn')?.click();
});
// ===== Event bindings =====
(function restoreCategories() {
    const saved = localStorage.getItem('memo-app-categories');
    if (saved !== null) {
        document.getElementById('category-input').value = saved;
    }
})();
document.getElementById('org-load-btn').addEventListener('keydown', (e) => {
    if (e.key !== 'Tab' || e.shiftKey)
        return;
    const outlineContent = document.getElementById('org-outline-content');
    if (outlineContent?.classList.contains('hidden'))
        return;
    const firstItem = document.querySelector('#org-outline .org-outline-item');
    if (!firstItem)
        return;
    e.preventDefault();
    firstItem.focus();
    firstItem.scrollIntoView({ block: 'nearest' });
});
/** ファイル読み込み成功後の画面状態リセット（"読込" ボタン押下時と同じ状態にする）。 */
function orgAfterFileLoaded() {
    setReloadFileBtnEnabled(fileSource.canReload());
    orgSelectedCharPos = null;
    orgSelectedRange = null;
    orgCollapsedOutlines.clear();
    orgOutline2CollapsedOutlines.clear();
    orgReorderSelectedOutlines.clear();
    orgOutlineSearchQuery = '';
    orgOutline2SearchQuery = '';
    const outlineSearchInput = document.getElementById('outline-search-input');
    if (outlineSearchInput)
        outlineSearchInput.value = '';
    const outline2SearchInput = document.getElementById('outline2-search-input');
    if (outline2SearchInput)
        outline2SearchInput.value = '';
    if (orgFileDropActive)
        orgDeactivateFileDropMode();
    orgUpdateSectionCurrentHeading(null);
    // Reset right panel to placeholder
    const container = document.getElementById('org-form2');
    container.innerHTML = '<p class="org-form-placeholder">アウトラインを選択するとセクション内容が表示されます</p>';
    const infoEl = document.getElementById('org-section-info');
    if (infoEl) {
        const lines = orgOriginalContent.split('\n').length;
        infoEl.textContent = `全${lines}行`;
    }
    updateTotalLines(orgOriginalContent);
    orgRenderOutline(orgOriginalContent);
    showOutlinePanel();
}
document.getElementById('org-load-btn').addEventListener('click', async () => {
    if (!await orgPickAndLoad())
        return;
    orgAfterFileLoaded();
});
// 分解開始
document.getElementById('process-btn').addEventListener('click', async () => {
    if (!orgOriginalContent.trim()) {
        await orgModalAlert('ファイルを読み込んでください');
        return;
    }
    if (orgSelectedCharPos === null) {
        await orgModalAlert('アウトラインを選択してください');
        return;
    }
    const range = getOutlineSectionRange(orgOriginalContent, orgSelectedCharPos);
    if (!range) {
        await orgModalAlert('セクションが見つかりません');
        return;
    }
    const lines = orgOriginalContent.split('\n');
    const sectionLines = lines.slice(range.start, range.end);
    const headingLine = sectionLines[0] ?? '';
    const headingMatch = headingLine.match(/^\*+ ?(.*)$/);
    const firstColName = headingMatch ? headingMatch[1].trim() || '未整理' : '未整理';
    const bodyText = sectionLines.slice(1).join('\n');
    const memos = parseMemos(bodyText);
    const mode = textGetMode();
    if (mode === 'text') {
        _n = 0;
        textDefaultOutline = firstColName;
        textRows = memos.map(m => ({ id: uid(), outline: '', content: m }));
        textSelectedIds.clear();
        textRenderRows();
        const lineCountEl = document.getElementById('text-content-linecount');
        if (lineCountEl)
            lineCountEl.textContent = `元${range.end - range.start}行`;
        hideGuiPanel();
        showTextPanel();
    }
    else {
        const catText = document.getElementById('category-input').value;
        const cats = parseCategories(catText);
        localStorage.setItem('memo-app-categories', catText);
        _n = 0;
        selected.clear();
        columns = [
            { id: uid(), name: firstColName, cards: memos.map(m => ({ id: uid(), content: m })) },
            ...cats.map(name => ({ id: uid(), name, cards: [] })),
        ];
        render();
        hideTextPanel();
        showGuiPanel();
    }
});
// GUI mode sort
document.getElementById('gui-sort-content-btn').addEventListener('click', async () => {
    if (!await orgModalConfirm('内容の文字列順でソートします（各列内）。よろしいですか？'))
        return;
    guiSortByContent();
});
// GUI mode 重複削除（確認ダイアログは重複件数・行数を含めて内部で表示する）
document.getElementById('gui-dedup-btn').addEventListener('click', async () => {
    await guiApplyDedup();
});
// GUI mode clear（表示中の内容をクリアしてアウトライン一覧へ戻る）
document.getElementById('gui-clear-btn').addEventListener('click', async () => {
    if (!await orgModalConfirm('GUI編集モードの表示内容をクリアします。よろしいですか？'))
        return;
    guiClearAndReturnToOutline();
});
// Export
document.getElementById('export-btn').addEventListener('click', async () => {
    if (!orgOriginalContent.trim()) {
        await orgModalAlert('ファイルを読み込んでください');
        return;
    }
    if (orgSelectedCharPos === null) {
        await orgModalAlert('アウトラインを選択してください');
        return;
    }
    const exportText = generateExport();
    if (!exportText.trim()) {
        await orgModalAlert('カードがありません');
        return;
    }
    const range = getOutlineSectionRange(orgOriginalContent, orgSelectedCharPos);
    if (!range) {
        await orgModalAlert('元のアウトラインが見つかりません');
        return;
    }
    const originalLines2 = orgOriginalContent.split('\n');
    const originalLineCount = range.end - range.start;
    const originalNonBlank = originalLines2.slice(range.start, range.end).filter(l => l.trim() !== '').length;
    const exportLines = exportText.split('\n');
    const exportLineCount = exportLines.length;
    const exportNonBlank = exportLines.filter(l => l.trim() !== '').length;
    const confirmed = await orgModalConfirm('元アウトラインを削除してファイル末尾に追加します:\n\n' +
        '元のアウトライン行数: ' + originalLineCount + ' 行（空行除く ' + originalNonBlank + ' 行）\n' +
        'Export行数: ' + exportLineCount + ' 行（空行除く ' + exportNonBlank + ' 行）\n\n' +
        'OKを押すと実行します。');
    if (!confirmed)
        return;
    const saved = await orgReplaceSelectedSectionWithExport(exportText);
    if (!saved)
        return;
    orgShowSectionForSelected();
    window.scrollTo(0, 0);
});
// 集約
document.getElementById('agg-run-btn').addEventListener('click', async () => {
    if (!orgOriginalContent.trim()) {
        await orgModalAlert('ファイルを読み込んでください');
        return;
    }
    let result;
    if (orgSelectedCharPos === null) {
        const hasLevel1 = orgGetOutlines(orgOriginalContent).some(o => o.level === 1);
        if (hasLevel1) {
            await orgModalAlert('アウトラインを選択してください');
            return;
        }
        result = orgAggregateContentImplicitRoot(orgOriginalContent);
        if (result === null) {
            await orgModalAlert('集約対象のアウトラインが見つかりません');
            return;
        }
    }
    else {
        result = orgAggregateContent(orgOriginalContent, orgSelectedCharPos);
        if (result === null) {
            await orgModalAlert('選択したアウトラインが見つかりません');
            return;
        }
    }
    if (result === orgOriginalContent) {
        await orgModalAlert('集約対象の子アウトラインがありません');
        return;
    }
    const origLines = orgOriginalContent.split('\n').length;
    const newLines = result.split('\n').length;
    const origNB = orgCountNonBlank(orgOriginalContent);
    const newNB = orgCountNonBlank(result);
    const confirmed = await orgModalConfirm('集約_n_ソートを実行します:\n\n' +
        '元ファイル:         ' + origLines + '行 / 空白以外: ' + origNB + '行\n' +
        '集約_n_ソート後: ' + newLines + '行 / 空白以外: ' + newNB + '行\n\n' +
        'OKを押すと適用・保存します。');
    if (!confirmed)
        return;
    const saved = await saveOrgContent(result);
    if (!saved)
        return;
    orgOriginalContent = result;
    orgSelectedCharPos = null;
    orgSelectedRange = null;
    if (orgFileDropActive)
        orgDeactivateFileDropMode();
    orgUpdateSectionCurrentHeading(null);
    const container = document.getElementById('org-form2');
    container.innerHTML = '<p class="org-form-placeholder">アウトラインを選択するとセクション内容が表示されます</p>';
    const infoEl = document.getElementById('org-section-info');
    if (infoEl) {
        const lines = orgOriginalContent.split('\n').length;
        infoEl.textContent = `全${lines}行`;
    }
    updateTotalLines(orgOriginalContent);
    orgRenderOutline(orgOriginalContent);
});
// 貼り付けた内容を「** 未整理」として末尾に追加
document.getElementById('append-unsorted-btn').addEventListener('click', () => {
    orgShowAppendUnsortedModal();
});
// 表示中のセクション内容を編集する
document.getElementById('section-edit-btn').addEventListener('click', () => {
    void orgShowSectionEditModal();
});
// 本文が空（空行のみ、または本文なし）のアウトラインの見出しに「[empty] 」を付与する
document.getElementById('mark-empty-outline-btn').addEventListener('click', async () => {
    if (!fileSource.canReload()) {
        await orgModalAlert('ファイルが読み込まれていません');
        return;
    }
    const lines = orgOriginalContent.split('\n');
    const outlines = orgGetOutlines(orgOriginalContent);
    const targets = [];
    for (const outline of outlines) {
        const m = outline.text.match(/^(\*+\s+)(.*)$/);
        if (!m)
            continue;
        const title = m[2];
        if (title.startsWith('[empty] '))
            continue; // 付与済み
        const range = getOutlineSectionRange(orgOriginalContent, outline.charPos);
        if (!range)
            continue;
        const bodyLines = lines.slice(range.start + 1, range.end);
        if (bodyLines.some(l => l.trim() !== ''))
            continue; // 空行以外の行がある
        targets.push({ lineIndex: outline.lineIndex, text: outline.text, stars: m[1], title });
    }
    if (targets.length === 0) {
        await orgModalAlert('対象のアウトライン（本文が空のアウトライン）がありませんでした');
        return;
    }
    const confirmed = await orgModalConfirm(`以下${targets.length}件のアウトラインの見出しに「[empty] 」を付与します:\n\n` +
        targets.map(t => '・' + t.text).join('\n') +
        '\n\nOKを押すと上書き保存します。');
    if (!confirmed)
        return;
    const selectedLineIdx = orgSelectedCharPos !== null
        ? charPosToLineIndex(orgOriginalContent, orgSelectedCharPos) : -1;
    const newLines = [...lines];
    for (const t of targets) {
        newLines[t.lineIndex] = `${t.stars}[empty] ${t.title}`;
    }
    const newContent = newLines.join('\n');
    const saved = await saveOrgContent(newContent);
    if (!saved)
        return;
    orgOriginalContent = newContent;
    if (selectedLineIdx >= 0) {
        const newOutlines = orgGetOutlines(orgOriginalContent);
        const sel = newOutlines.find(o => o.lineIndex === selectedLineIdx);
        orgSelectedCharPos = sel ? sel.charPos : null;
        orgSelectedRange = orgSelectedCharPos !== null
            ? getOutlineSectionRange(orgOriginalContent, orgSelectedCharPos) : null;
    }
    updateTotalLines(orgOriginalContent);
    orgRenderOutline(orgOriginalContent);
    await orgModalAlert(`${targets.length}件のアウトラインに「[empty] 」を付与し、保存しました。`);
});
// Column width slider
document.getElementById('col-width-slider').addEventListener('input', (e) => {
    colWidth = parseInt(e.target.value, 10);
    const valEl = document.getElementById('col-width-val');
    if (valEl)
        valEl.textContent = String(colWidth);
    const board = document.getElementById('board');
    if (board) {
        board.style.setProperty('--col-width', colWidth + 'px');
        board.querySelectorAll('.column').forEach(col => {
            col.style.minWidth = colWidth + 'px';
            col.style.width = colWidth + 'px';
        });
    }
});
// Auto-scroll on drag
window.addEventListener('dragover', (e) => {
    if (!dragInfo) {
        _stopAutoScroll();
        return;
    }
    const bw = document.querySelector('.board-wrap');
    if (!bw) {
        _stopAutoScroll();
        return;
    }
    const rect = bw.getBoundingClientRect();
    if (e.clientY < rect.top || e.clientY > rect.bottom) {
        _stopAutoScroll();
        return;
    }
    const edge = 120, maxSpd = 25;
    if (e.clientX < rect.left + edge) {
        _startAutoScroll(-Math.ceil((1 - (e.clientX - rect.left) / edge) * maxSpd));
    }
    else if (e.clientX > rect.right - edge) {
        _startAutoScroll(Math.ceil((1 - (rect.right - e.clientX) / edge) * maxSpd));
    }
    else {
        _stopAutoScroll();
    }
});
document.addEventListener('dragend', _stopAutoScroll);
// マウスホイールでの横スクロール補助（カテゴリが多く横に長い場合、通常のホイール操作で横スクロールできるようにする）
(function initBoardWheelScroll() {
    const bw = document.querySelector('.board-wrap');
    if (!bw)
        return;
    bw.addEventListener('wheel', (e) => {
        if (e.deltaY === 0 || e.deltaX !== 0)
            return;
        if (bw.scrollHeight > bw.clientHeight + 1)
            return; // 縦に長い列がある場合は通常の縦スクロールを優先する
        if (bw.scrollWidth <= bw.clientWidth + 1)
            return; // 横にはみ出していなければ何もしない
        e.preventDefault();
        bw.scrollLeft += e.deltaY;
    }, { passive: false });
})();
// Org file reload button
document.getElementById('org-reload-file-btn').addEventListener('click', async () => {
    await orgReloadFile();
});
// Reload button
document.getElementById('reload-btn').addEventListener('click', async () => {
    if (await orgModalConfirm('ページをリロードします。\n入力・分類データは全て失われます。よろしいですか？')) {
        window.location.reload();
    }
});
// 最終コミット日時表示（dist/build-info.js が生成する window.APP_LAST_COMMIT_LABEL を表示。
// ビルド前など未生成の場合は何も表示しない）
(function initLastCommitLabel() {
    const label = window.APP_LAST_COMMIT_LABEL;
    if (!label)
        return;
    const el = document.getElementById('app-last-commit');
    if (el)
        el.textContent = `最終コミット: ${label}`;
})();
// トップレベルのアウトライン以下をすべて折りたたむ/展開（左のアウトライン一覧）
document.getElementById('outline-collapse-all-btn').addEventListener('click', (e) => {
    orgToggleCollapseAll(orgGetOutlines(orgOriginalContent), orgCollapsedOutlines);
    orgRenderOutline(orgOriginalContent);
    e.currentTarget.blur();
});
// トップレベルのアウトライン以下をすべて折りたたむ/展開（「アウトライン一覧」タブ）
document.getElementById('outline2-collapse-all-btn').addEventListener('click', (e) => {
    const container = document.getElementById('org-form2');
    if (container)
        orgOutline2ScrollTop = container.scrollTop;
    orgToggleCollapseAll(orgGetOutlines(orgOriginalContent), orgOutline2CollapsedOutlines);
    orgRenderOutlineMirrorList();
    e.currentTarget.blur();
});
// アウトライン一覧の絞り込み検索（左）
document.getElementById('outline-search-input').addEventListener('input', (e) => {
    orgOutlineSearchQuery = e.target.value;
    orgRenderOutline(orgOriginalContent);
});
// アウトライン一覧の絞り込み検索（「アウトライン一覧」タブ）
document.getElementById('outline2-search-input').addEventListener('input', (e) => {
    orgOutline2SearchQuery = e.target.value;
    orgOutline2ScrollTop = 0; // 絞り込みが変わったら先頭から表示し直す
    orgRenderOutlineMirrorList();
});
// Scroll buttons for outline and section
document.getElementById('outline-top-btn').addEventListener('click', (e) => {
    document.getElementById('org-outline').scrollTop = 0;
    e.currentTarget.blur();
});
document.getElementById('outline-bottom-btn').addEventListener('click', (e) => {
    const el = document.getElementById('org-outline');
    el.scrollTop = el.scrollHeight;
    e.currentTarget.blur();
});
document.getElementById('section-top-btn').addEventListener('click', (e) => {
    document.getElementById('org-form2').scrollTop = 0;
    e.currentTarget.blur();
});
document.getElementById('section-bottom-btn').addEventListener('click', (e) => {
    const el = document.getElementById('org-form2');
    el.scrollTop = el.scrollHeight;
    e.currentTarget.blur();
});
// Scroll buttons for text mode
document.getElementById('text-top-btn').addEventListener('click', (e) => {
    document.getElementById('text-rows-container').scrollTop = 0;
    e.currentTarget.blur();
});
document.getElementById('text-bottom-btn').addEventListener('click', (e) => {
    const el = document.getElementById('text-rows-container');
    el.scrollTop = el.scrollHeight;
    e.currentTarget.blur();
});
// Scroll buttons for GUI (board) mode
document.getElementById('board-top-btn').addEventListener('click', (e) => {
    document.querySelector('.board-wrap').scrollTop = 0;
    e.currentTarget.blur();
});
document.getElementById('board-bottom-btn').addEventListener('click', (e) => {
    const el = document.querySelector('.board-wrap');
    el.scrollTop = el.scrollHeight;
    e.currentTarget.blur();
});
// Home/End キーで、▲/▼ ボタンと同じ各エリアの先頭・末尾へのスクロールを行う。
// フォーカスがこれらのエリア内にあればそれを対象にし、無ければマウスカーソルが乗っているエリアを対象にする。
const HOME_END_SCROLL_AREAS_SELECTOR = '#org-outline, #org-form2, #text-rows-container, .board-wrap';
let hoveredScrollArea = null;
document.querySelectorAll(HOME_END_SCROLL_AREAS_SELECTOR).forEach(el => {
    el.addEventListener('mouseenter', () => { hoveredScrollArea = el; });
    el.addEventListener('mouseleave', () => { if (hoveredScrollArea === el)
        hoveredScrollArea = null; });
});
document.addEventListener('keydown', (e) => {
    if (e.key !== 'Home' && e.key !== 'End')
        return;
    const target = e.target;
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
        return;
    const container = target.closest(HOME_END_SCROLL_AREAS_SELECTOR) ?? hoveredScrollArea;
    if (!container)
        return;
    e.preventDefault();
    container.scrollTop = e.key === 'Home' ? 0 : container.scrollHeight;
});
document.getElementById('line-num-toggle-btn').addEventListener('click', (e) => {
    const form2 = document.getElementById('org-form2');
    const btn = e.currentTarget;
    const nowHidden = form2.classList.toggle('hide-line-nums');
    btn.classList.toggle('active', !nowHidden);
    btn.blur();
});
// カードドラッグモード: 通常時はテキスト選択・コピーができるよう、既定ではカードのドラッグを無効にしておく
document.getElementById('section-card-mode-btn').addEventListener('click', (e) => {
    orgSectionCardModeActive = !orgSectionCardModeActive;
    e.currentTarget.classList.toggle('active', orgSectionCardModeActive);
    e.currentTarget.blur();
    // モード切替では先頭までスクロールし直さず、切替前のスクロール位置を保つ
    const container = document.getElementById('org-form2');
    const prevScrollTop = container?.scrollTop ?? 0;
    orgShowSectionForSelected();
    if (container)
        container.scrollTop = prevScrollTop;
});
// Text mode sort
document.getElementById('text-sort-btn').addEventListener('click', async () => {
    if (!await orgModalConfirm('アウトライン欄の並び順でソートします。よろしいですか？'))
        return;
    textSort();
});
document.getElementById('text-sort-content-btn').addEventListener('click', async () => {
    if (!await orgModalConfirm('内容の文字列順でソートします。よろしいですか？'))
        return;
    textSortByContent();
});
// Text mode 重複削除（確認ダイアログは重複件数・行数を含めて内部で表示する）
document.getElementById('text-dedup-btn').addEventListener('click', async () => {
    await textApplyDedup();
});
// Text mode clear（表示中の内容をクリアしてアウトライン一覧へ戻る）
document.getElementById('text-clear-btn').addEventListener('click', async () => {
    if (!await orgModalConfirm('テキスト編集モードの表示内容をクリアします。よろしいですか？'))
        return;
    textClearAndReturnToOutline();
});
// Text mode rule-based outline auto-fill
document.getElementById('text-rule1-btn').addEventListener('click', async () => {
    if (!await orgModalConfirm('TODO設定を実行します。よろしいですか？'))
        return;
    await textApplyRule1();
});
document.getElementById('text-rule2-btn').addEventListener('click', async () => {
    if (!await orgModalConfirm('一致アウトライン設定を実行します。よろしいですか？'))
        return;
    await textApplyRule2();
});
document.getElementById('text-todo-prefix-btn').addEventListener('click', async () => {
    if (!await orgModalConfirm('TODO付与を実行します。よろしいですか？'))
        return;
    await textApplyTodoPrefix();
});
// Text mode export
document.getElementById('text-export-btn').addEventListener('click', async () => {
    if (!orgOriginalContent.trim()) {
        await orgModalAlert('ファイルを読み込んでください');
        return;
    }
    if (orgSelectedCharPos === null) {
        await orgModalAlert('アウトラインを選択してください');
        return;
    }
    const exportText = textGenerateExport();
    if (!exportText.trim()) {
        await orgModalAlert('内容がありません');
        return;
    }
    const range = getOutlineSectionRange(orgOriginalContent, orgSelectedCharPos);
    if (!range) {
        await orgModalAlert('元のアウトラインが見つかりません');
        return;
    }
    const originalLines2 = orgOriginalContent.split('\n');
    const originalLineCount = range.end - range.start;
    const originalNonBlank = originalLines2.slice(range.start, range.end).filter(l => l.trim() !== '').length;
    const exportLines = exportText.split('\n');
    const exportLineCount = exportLines.length;
    const exportNonBlank = exportLines.filter(l => l.trim() !== '').length;
    const confirmed = await orgModalConfirm('元アウトラインを削除してファイル末尾に追加します:\n\n' +
        '元のアウトライン行数: ' + originalLineCount + ' 行（空行除く ' + originalNonBlank + ' 行）\n' +
        'Export行数: ' + exportLineCount + ' 行（空行除く ' + exportNonBlank + ' 行）\n\n' +
        'OKを押すと実行します。');
    if (!confirmed)
        return;
    const saved = await orgReplaceSelectedSectionWithExport(exportText);
    if (!saved)
        return;
    orgShowSectionForSelected();
    // 上書き保存済みの内容を再度「置換え」して二重書き込みしてしまわないよう、表示中の内容をクリアする
    textClearAndReturnToOutline();
});
