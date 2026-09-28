// 文件头识别（server/reader/image-size.ts）：尺寸与 MIME 都不看扩展名。
// 这些是真实数据里踩过的坑：藏品库有名为 `640` 的无扩展名图片；.jpg/.png 封面曾拿不到尺寸
// 被强行按 4:3 裁切；还有 3 个文件其实是下载失败时存下的 500 JSON 响应。
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { imageSize, sniffImageMime } from '../server/reader/image-size';
import { fakeImageBody, tinyGif, tinyJpeg, tinyPng, tinyWebp } from './helpers/fixture';

function tmpFile(bytes: Buffer, name = 'sample'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myinfobase-img-'));
  const p = path.join(dir, name);
  fs.writeFileSync(p, bytes);
  return p;
}

describe('imageSize：按文件头读尺寸', () => {
  it('WebP（VP8L）', () => {
    expect(imageSize(tmpFile(tinyWebp(11, 7), 'a.webp'))).toEqual({ width: 11, height: 7 });
  });

  it('PNG（读 IHDR，扩展名无关）', () => {
    expect(imageSize(tmpFile(tinyPng(120, 90), 'a.png'))).toEqual({ width: 120, height: 90 });
  });

  it('PNG 无扩展名也能读（真实库里叫 640 的那批）', () => {
    expect(imageSize(tmpFile(tinyPng(1080, 1054), '640'))).toEqual({ width: 1080, height: 1054 });
  });

  it('GIF', () => {
    expect(imageSize(tmpFile(tinyGif(320, 240), 'a.gif'))).toEqual({ width: 320, height: 240 });
  });

  it('JPEG（跳过 APP0 段取 SOF0）', () => {
    expect(imageSize(tmpFile(tinyJpeg(640, 480), 'a.jpg'))).toEqual({ width: 640, height: 480 });
  });

  it('JPEG：SOF 在超长 EXIF 段之后仍能读到（按段长跳段，不是多读几百字节）', () => {
    const p = tmpFile(tinyJpeg(3024, 4032, 40_000), 'big.jpg');
    expect(imageSize(p)).toEqual({ width: 3024, height: 4032 });
  });

  it('损坏/非图片内容返回 null，不抛错', () => {
    expect(imageSize(tmpFile(fakeImageBody(), 'a.jpg'))).toBeNull();
    expect(imageSize(tmpFile(Buffer.alloc(3), 'tiny.png'))).toBeNull();
    expect(imageSize(path.join(os.tmpdir(), 'myinfobase-does-not-exist.png'))).toBeNull();
  });

  it('SVG 没有位图尺寸：返回 null（调用方按 4:3 占位）', () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"></svg>');
    expect(imageSize(tmpFile(svg, 'a.svg'))).toBeNull();
  });
});

describe('sniffImageMime：按文件头判类型', () => {
  it.each([
    [() => tinyPng(), 'image/png'],
    [() => tinyGif(), 'image/gif'],
    [() => tinyJpeg(), 'image/jpeg'],
    [() => tinyWebp(), 'image/webp'],
  ])('识别 %#', (make, expected) => {
    expect(sniffImageMime(tmpFile(make(), 'unknown'))).toBe(expected);
  });

  it('SVG 判定为图片（占位封面就是它）', () => {
    const svg = Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"></svg>');
    expect(sniffImageMime(tmpFile(svg, '封面.svg'))).toBe('image/svg+xml');
  });

  it('下载失败留下的 JSON 响应体不是图片', () => {
    expect(sniffImageMime(tmpFile(fakeImageBody(), '640'))).toBeNull();
  });
});
