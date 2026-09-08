import { closeIndexedDbOnVersionChange, ensureIndexedDbSchema, INDEXED_DB } from '@/lib/storage-contract';

export interface PreparedUploadImage {
    id: string;
    name: string;
    preview: string;
    dataUrl: string;
    mimeType: string;
    originalSize: number;
    processedSize: number;
    width: number;
    height: number;
    cacheHit: boolean;
}

interface CachedUploadImage {
    key: string;
    name: string;
    mimeType: string;
    dataUrl: string;
    originalSize: number;
    processedSize: number;
    width: number;
    height: number;
    createdAt: number;
}

const UPLOAD_CACHE_DB_CONTRACT = INDEXED_DB.uploadCache;
const DB_NAME = UPLOAD_CACHE_DB_CONTRACT.name;
const DB_VERSION = UPLOAD_CACHE_DB_CONTRACT.version;
const STORE_NAME = UPLOAD_CACHE_DB_CONTRACT.stores[0].name;

function openDB(): Promise<IDBDatabase | null> {
    if (typeof indexedDB === 'undefined') return Promise.resolve(null);

    return new Promise((resolve) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onerror = () => resolve(null);
        request.onupgradeneeded = () => {
            ensureIndexedDbSchema(request.result, request.transaction, UPLOAD_CACHE_DB_CONTRACT);
        };
        request.onsuccess = () => {
            closeIndexedDbOnVersionChange(request.result);
            resolve(request.result);
        };
    });
}

async function getCachedImage(key: string): Promise<CachedUploadImage | null> {
    const db = await openDB();
    if (!db) return null;

    return new Promise((resolve) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const req = tx.objectStore(STORE_NAME).get(key);
        req.onsuccess = () => {
            db.close();
            resolve((req.result as CachedUploadImage) || null);
        };
        req.onerror = () => {
            db.close();
            resolve(null);
        };
    });
}

async function saveCachedImage(record: CachedUploadImage): Promise<void> {
    const db = await openDB();
    if (!db) return;

    return new Promise((resolve) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).put(record);
        tx.oncomplete = () => {
            db.close();
            resolve();
        };
        tx.onerror = () => {
            db.close();
            resolve();
        };
    });
}

function bufferToHex(buffer: ArrayBuffer): string {
    return Array.from(new Uint8Array(buffer))
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
}

/**
 * 计算上传文件的稳定缓存键。
 *
 * 优先使用 Web Crypto 的 SHA-256；但 Web Crypto 的 subtle API 在通过普通 HTTP
 * 访问的非安全上下文中可能不存在。图片上传本身不应依赖 HTTPS，因此在该能力
 * 不可用或调用失败时，改用双路 32 位 FNV-1a 内容哈希作为缓存键。这个降级哈希
 * 只用于本地上传缓存和重复文件去重，不用于安全校验、签名或权限判断。
 *
 * @param file 待计算缓存键的本地图片文件。
 * @returns 稳定的十六进制缓存键。
 */
async function hashFile(file: File): Promise<string> {
    const buffer = await file.arrayBuffer();
    const subtle = typeof crypto !== 'undefined' ? crypto.subtle : undefined;

    if (subtle) {
        try {
            const digest = await subtle.digest('SHA-256', buffer);
            return bufferToHex(digest);
        } catch {
            // 非安全上下文、浏览器策略或运行时实现异常时继续使用本地降级哈希。
        }
    }

    return `fallback-${hashBytesForCache(new Uint8Array(buffer))}`;
}

/**
 * 在 Web Crypto 不可用时，使用两路 FNV-1a 计算本地缓存专用内容哈希。
 *
 * 两个独立的 32 位状态共同组成 64 位十六进制结果，避免把缓存能力绑定到
 * 安全上下文。每一步都使用 Math.imul 保持 32 位整数乘法语义，避免 JavaScript
 * 浮点数在大文件遍历时丢失低位信息。
 *
 * @param bytes 文件的完整二进制内容。
 * @returns 由两路 32 位状态拼成的十六进制哈希。
 */
function hashBytesForCache(bytes: Uint8Array): string {
    let first = 0x811c9dc5;
    let second = 0x9e3779b1;

    for (const byte of bytes) {
        first = Math.imul(first ^ byte, 0x01000193);
        second = Math.imul(second ^ byte, 0x01000193);
    }

    first = Math.imul(first ^ bytes.length, 0x01000193);
    second = Math.imul(second ^ bytes.length, 0x01000193);

    return `${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0).toString(16).padStart(8, '0')}`;
}

function readFileAsDataUrl(file: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
    });
}

function loadImageFromDataUrl(dataUrl: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('图片加载失败'));
        img.src = dataUrl;
    });
}

function dataUrlToSize(dataUrl: string): number {
    const base64 = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;
    return Math.ceil((base64.length * 3) / 4);
}

async function canvasToDataUrl(canvas: HTMLCanvasElement, mimeType: string, quality?: number): Promise<string> {
    return new Promise((resolve, reject) => {
        canvas.toBlob((blob) => {
            if (!blob) {
                reject(new Error('图片导出失败'));
                return;
            }

            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result || ''));
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(blob);
        }, mimeType, quality);
    });
}

function getBestMimeType(fileType: string): 'image/png' | 'image/jpeg' | 'image/webp' {
    if (fileType === 'image/webp') return 'image/webp';
    if (fileType === 'image/png') return 'image/png';
    return 'image/jpeg';
}

const FAST_COMPRESS_THRESHOLD_BYTES = 1.5 * 1024 * 1024;
const MAX_OUTPUT_SIDE = 2560;
const MAX_OUTPUT_PIXELS = 5_000_000;
const JPEG_QUALITY = 0.86;
const WEBP_QUALITY = 0.9;

function getTargetDimensions(width: number, height: number): { width: number; height: number } {
    if (width <= 0 || height <= 0) {
        return { width: 1, height: 1 };
    }

    const sideScale = Math.min(1, MAX_OUTPUT_SIDE / Math.max(width, height));
    const pixelScale = Math.min(1, Math.sqrt(MAX_OUTPUT_PIXELS / (width * height)));
    const scale = Math.min(sideScale, pixelScale);

    return {
        width: Math.max(1, Math.round(width * scale)),
        height: Math.max(1, Math.round(height * scale)),
    };
}

function getFastOutputMimeType(inputMimeType: string): 'image/jpeg' | 'image/webp' {
    const normalized = inputMimeType.toLowerCase();
    if (normalized === 'image/png' || normalized === 'image/webp') {
        return 'image/webp';
    }
    return 'image/jpeg';
}

function yieldToMainThread(): Promise<void> {
    return new Promise((resolve) => {
        requestAnimationFrame(() => resolve());
    });
}

async function optimiseWithCanvasFallback(file: File, dataUrl: string): Promise<{ dataUrl: string; mimeType: string; width: number; height: number; processedSize: number }> {
    const img = await loadImageFromDataUrl(dataUrl);

    const width = img.naturalWidth || img.width;
    const height = img.naturalHeight || img.height;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;

    const ctx = canvas.getContext('2d');
    if (!ctx) {
        return {
            dataUrl,
            mimeType: file.type || 'image/png',
            width,
            height,
            processedSize: file.size,
        };
    }

    ctx.drawImage(img, 0, 0);
    const outputMimeType = getBestMimeType(file.type);

    if (outputMimeType === 'image/jpeg') {
        return {
            dataUrl,
            mimeType: file.type || outputMimeType,
            width,
            height,
            processedSize: file.size,
        };
    }

    const fallbackDataUrl = await canvasToDataUrl(canvas, outputMimeType, outputMimeType === 'image/png' ? undefined : 0.98);

    return {
        dataUrl: fallbackDataUrl,
        mimeType: outputMimeType,
        width,
        height,
        processedSize: dataUrlToSize(fallbackDataUrl),
    };
}

async function optimizeImage(file: File): Promise<{ dataUrl: string; mimeType: string; width: number; height: number; processedSize: number }> {
    const originalDataUrl = await readFileAsDataUrl(file);
    const img = await loadImageFromDataUrl(originalDataUrl);
    const width = img.naturalWidth || img.width;
    const height = img.naturalHeight || img.height;

    const mimeType = (file.type || '').toLowerCase();

    // 小图直接跳过压缩，优先响应速度。
    if (file.size <= FAST_COMPRESS_THRESHOLD_BYTES) {
        return {
            dataUrl: originalDataUrl,
            mimeType: file.type || mimeType || 'image/jpeg',
            width,
            height,
            processedSize: file.size,
        };
    }

    try {
        const { width: targetWidth, height: targetHeight } = getTargetDimensions(width, height);
        await yieldToMainThread();

        const canvas = document.createElement('canvas');
        canvas.width = targetWidth;
        canvas.height = targetHeight;

        const ctx = canvas.getContext('2d');
        if (!ctx) {
            return {
                dataUrl: originalDataUrl,
                mimeType: file.type || 'application/octet-stream',
                width,
                height,
                processedSize: file.size,
            };
        }

        ctx.drawImage(img, 0, 0, targetWidth, targetHeight);

        const outputMimeType = getFastOutputMimeType(mimeType);
        const quality = outputMimeType === 'image/webp' ? WEBP_QUALITY : JPEG_QUALITY;
        const compressedDataUrl = await canvasToDataUrl(canvas, outputMimeType, quality);
        const compressedSize = dataUrlToSize(compressedDataUrl);

        if (compressedSize >= file.size * 0.98) {
            return {
                dataUrl: originalDataUrl,
                mimeType: file.type || outputMimeType,
                width,
                height,
                processedSize: file.size,
            };
        }

        return {
            dataUrl: compressedDataUrl,
            mimeType: outputMimeType,
            width: targetWidth,
            height: targetHeight,
            processedSize: compressedSize,
        };
    } catch {
        return optimiseWithCanvasFallback(file, originalDataUrl);
    }
}

/**
 * Generate a display badge for an uploaded image.
 * Returns "缓存" when cache is hit, "-N%" when compression saved >= 5%,
 * and undefined when there's no meaningful saving to report.
 */
export function getOptimizationBadge(
  originalSize: number,
  processedSize: number,
  cacheHit: boolean,
): string | undefined {
  if (cacheHit) return '缓存';
  if (originalSize <= 0 || processedSize >= originalSize) return undefined;
  const savedPercent = Math.round((1 - processedSize / originalSize) * 100);
  return savedPercent >= 5 ? `-${savedPercent}%` : undefined;
}

export async function prepareUploadImage(file: File): Promise<PreparedUploadImage> {
    const key = await hashFile(file);
    const cached = await getCachedImage(key);

    if (cached) {
        return {
            id: key,
            name: cached.name || file.name,
            preview: cached.dataUrl,
            dataUrl: cached.dataUrl,
            mimeType: cached.mimeType,
            originalSize: cached.originalSize,
            processedSize: cached.processedSize,
            width: cached.width,
            height: cached.height,
            cacheHit: true,
        };
    }

    const optimized = await optimizeImage(file);
    const record: CachedUploadImage = {
        key,
        name: file.name,
        mimeType: optimized.mimeType,
        dataUrl: optimized.dataUrl,
        originalSize: file.size,
        processedSize: optimized.processedSize,
        width: optimized.width,
        height: optimized.height,
        createdAt: Date.now(),
    };

    await saveCachedImage(record);

    return {
        id: key,
        name: file.name,
        preview: optimized.dataUrl,
        dataUrl: optimized.dataUrl,
        mimeType: optimized.mimeType,
        originalSize: file.size,
        processedSize: optimized.processedSize,
        width: optimized.width,
        height: optimized.height,
        cacheHit: false,
    };
}
