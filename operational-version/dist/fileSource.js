"use strict";
// ===== File source abstraction =====
// ファイルの読み込み・保存処理を抽象化するレイヤー。
// このフォルダではフロントエンドのみで動く BrowserOrgFileSource しか実装しないが、
// サーバーサイドで動かす場合はここに OrgFileSource を実装した別クラス（例: サーバー上の
// 指定パスを読み書きするもの）を追加し、fileSource の中身をそれに差し替えるだけで良いように
// インターフェースを分離しておく。main.ts 側は具体的な実装 (File System Access API など) を
// 直接扱わず、この OrgFileSource 経由でのみファイル入出力を行う。
//
// 注意: このファイルは ES モジュールにしない（import/export を使わない）。
// index.html はローカルファイル (file://) から直接開かれる想定であり、
// type="module" にすると Chrome 等が file:// 上でのモジュール読込を CORS でブロックしてしまうため、
// dist/fileSource.js → dist/main.js の順に読み込む通常の <script> タグ（グローバルスコープ）で構成する。
class BrowserOrgFileSource {
    constructor() {
        this.handle = null;
    }
    async pickAndLoad() {
        if ('showOpenFilePicker' in window) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const [handle] = await window.showOpenFilePicker();
            this.handle = handle;
            const file = await handle.getFile();
            const content = await file.text();
            return { content, name: file.name };
        }
        return new Promise(resolve => {
            const inp = document.createElement('input');
            inp.type = 'file';
            inp.onchange = async () => {
                const file = inp.files?.[0];
                if (!file) {
                    resolve(null);
                    return;
                }
                this.handle = null;
                const content = await file.text();
                resolve({ content, name: file.name });
            };
            inp.click();
        });
    }
    async loadFromRef(ref) {
        const handle = ref;
        this.handle = handle;
        const file = await handle.getFile();
        const content = await file.text();
        return { content, name: file.name };
    }
    canReload() {
        return this.handle !== null;
    }
    async reload() {
        if (!this.handle)
            throw new Error('再読込可能なファイルがありません');
        const file = await this.handle.getFile();
        return file.text();
    }
    async save(content, suggestedFileName) {
        if (this.handle) {
            const writable = await this.handle.createWritable();
            await writable.write(content);
            await writable.close();
            return;
        }
        const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = suggestedFileName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(a.href);
    }
    async pickDirectory() {
        if (!('showDirectoryPicker' in window)) {
            throw new Error('このブラウザはディレクトリ選択に対応していません');
        }
        try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            return await window.showDirectoryPicker({ mode: 'readwrite' });
        }
        catch {
            return null;
        }
    }
    async findFileInDirectory(dir, baseName) {
        return this.findFileRecursive(dir, baseName);
    }
    async findFileRecursive(dir, title) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for await (const [name, entry] of dir) {
            if (entry.kind === 'file') {
                const baseName = name.replace(/\.[^.]+$/, '');
                if (baseName === title) {
                    return { ref: entry, path: name };
                }
            }
            else if (entry.kind === 'directory') {
                const found = await this.findFileRecursive(entry, title);
                if (found)
                    return { ref: found.ref, path: name + '/' + found.path };
            }
        }
        return null;
    }
    async listOrgFiles(dir) {
        const result = [];
        await this.listOrgFilesRecursive(dir, '', result);
        result.sort((a, b) => a.path.localeCompare(b.path));
        return result;
    }
    async listOrgFilesRecursive(dir, prefix, result) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for await (const [name, entry] of dir) {
            if (entry.kind === 'file') {
                if (/\.org$/i.test(name)) {
                    result.push({ ref: entry, path: prefix + name });
                }
            }
            else if (entry.kind === 'directory') {
                await this.listOrgFilesRecursive(entry, prefix + name + '/', result);
            }
        }
    }
    async isCurrentFile(ref) {
        if (!this.handle)
            return false;
        try {
            return await this.handle.isSameEntry(ref);
        }
        catch {
            return false;
        }
    }
    async readFile(ref) {
        const file = await ref.getFile();
        return file.text();
    }
    async writeFile(ref, content) {
        const handle = ref;
        const writable = await handle.createWritable();
        await writable.write(content);
        await writable.close();
    }
    async createFile(dir, fileName) {
        return dir.getFileHandle(fileName, { create: true });
    }
}
// 現在の実装（フロントエンドのみ）。サーバーサイド版に差し替える際はここを変更する。
const fileSource = new BrowserOrgFileSource();
