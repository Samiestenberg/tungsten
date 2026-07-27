/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Genererar Tungstens PLATSHÅLLARIKON: ett T på krämbakgrund.
//
// Varför en generator och inte bara binärfiler: ikonen är en platshållare, inte
// en designad logotyp. Så länge den är genererad går den att göra om, granska
// och byta ut utan att någon behöver gissa vilka färger eller mått som gällde.
//
// Formen är samma T som extensions/freya/media/freya.svg (samma path, skalad
// från 24x24), och färgerna kommer ur Tungsten Cream-temat.
//
// Kör:
//   node --experimental-strip-types build/icons/tungstenPlaceholderIcon.ts
//
// Skriver resources/win32/code.ico, code_70x70.png och code_150x150.png.

import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';

const ROOT = path.dirname(path.dirname(import.meta.dirname));

// Tungsten Cream: editor.background och accenten som används för ramar/badges.
const BG: RGB = [0xf4, 0xee, 0xe2];
const BORDER: RGB = [0xe0, 0xd3, 0xbc];
const GLYPH: RGB = [0xc1, 0x5f, 0x3c];

type RGB = [number, number, number];

/** freya.svg: M5 4h14v3.2h-5.4V20h-3.2V7.2H5V4z i en 24x24-ruta. */
const GLYPH_BOX = 24;
const CROSSBAR = { x0: 5, y0: 4, x1: 19, y1: 7.2 };
const STEM = { x0: 10.4, y0: 7.2, x1: 13.6, y1: 20 };

const SS = 4; // supersampling per axel -> 16 sampel/pixel, räcker för kantutjämning

function inRect(x: number, y: number, r: { x0: number; y0: number; x1: number; y1: number }): boolean {
	return x >= r.x0 && x < r.x1 && y >= r.y0 && y < r.y1;
}

/** Rundade hörn: utanför radien i hörnkvadranten -> transparent. */
function insideRoundedSquare(x: number, y: number, size: number, radius: number): boolean {
	if (x < 0 || y < 0 || x >= size || y >= size) {
		return false;
	}
	const cx = x < radius ? radius : x > size - radius ? size - radius : x;
	const cy = y < radius ? radius : y > size - radius ? size - radius : y;
	const dx = x - cx;
	const dy = y - cy;
	return dx * dx + dy * dy <= radius * radius;
}

/** RGBA-buffert, rad för rad ovanifrån. */
function render(size: number): Buffer {
	const out = Buffer.alloc(size * size * 4);
	const radius = Math.max(2, size * 0.18);
	const border = Math.max(1, size / 32);
	const scale = size / GLYPH_BOX;

	for (let py = 0; py < size; py++) {
		for (let px = 0; px < size; px++) {
			let rSum = 0, gSum = 0, bSum = 0, aSum = 0;

			for (let sy = 0; sy < SS; sy++) {
				for (let sx = 0; sx < SS; sx++) {
					const x = px + (sx + 0.5) / SS;
					const y = py + (sy + 0.5) / SS;

					if (!insideRoundedSquare(x, y, size, radius)) {
						continue; // transparent utanför plattan
					}

					// Glyfen ritas i 24x24-koordinater.
					const gx = x / scale;
					const gy = y / scale;
					const onGlyph = inRect(gx, gy, CROSSBAR) || inRect(gx, gy, STEM);

					// Ramen är plattans yttersta band.
					const onBorder = !insideRoundedSquare(x, y, size, radius - border)
						|| x < border || y < border || x >= size - border || y >= size - border;

					const color: RGB = onGlyph ? GLYPH : onBorder ? BORDER : BG;
					rSum += color[0];
					gSum += color[1];
					bSum += color[2];
					aSum += 255;
				}
			}

			const samples = SS * SS;
			const i = (py * size + px) * 4;
			if (aSum === 0) {
				continue; // helt transparent
			}
			// Färgen viktas mot de täckta samplen så kanten inte blir mörk.
			const covered = aSum / 255;
			out[i] = Math.round(rSum / covered);
			out[i + 1] = Math.round(gSum / covered);
			out[i + 2] = Math.round(bSum / covered);
			out[i + 3] = Math.round(aSum / samples);
		}
	}
	return out;
}

function crc32(buf: Buffer): number {
	let c = ~0;
	for (let i = 0; i < buf.length; i++) {
		c ^= buf[i];
		for (let k = 0; k < 8; k++) {
			c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
		}
	}
	return ~c >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
	const len = Buffer.alloc(4);
	len.writeUInt32BE(data.length, 0);
	const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(typeAndData), 0);
	return Buffer.concat([len, typeAndData, crc]);
}

function toPng(rgba: Buffer, size: number): Buffer {
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(size, 0);
	ihdr.writeUInt32BE(size, 4);
	ihdr[8] = 8;  // bitdjup
	ihdr[9] = 6;  // RGBA
	// resten (komprimering, filter, interlace) är 0

	// Filtertyp 0 per rad.
	const raw = Buffer.alloc(size * (size * 4 + 1));
	for (let y = 0; y < size; y++) {
		raw[y * (size * 4 + 1)] = 0;
		rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
	}

	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		pngChunk('IHDR', ihdr),
		pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
		pngChunk('IEND', Buffer.alloc(0)),
	]);
}

/**
 * 32-bitars BMP (DIB) för ICO. Medvetet BMP och inte PNG-i-ICO: BMP-entries
 * fungerar i varje Windows-version och i varje verktyg som läser ikonen,
 * inklusive rcedit när exe-filen får sin ikon.
 */
function toIcoBmp(rgba: Buffer, size: number): Buffer {
	const header = Buffer.alloc(40);
	header.writeUInt32LE(40, 0);
	header.writeInt32LE(size, 4);
	header.writeInt32LE(size * 2, 8); // höjd = bild + AND-mask
	header.writeUInt16LE(1, 12);
	header.writeUInt16LE(32, 14);
	header.writeUInt32LE(size * size * 4, 20);

	// BGRA, nedifrån och upp.
	const pixels = Buffer.alloc(size * size * 4);
	for (let y = 0; y < size; y++) {
		const src = (size - 1 - y) * size * 4;
		for (let x = 0; x < size; x++) {
			const s = src + x * 4;
			const d = (y * size + x) * 4;
			pixels[d] = rgba[s + 2];
			pixels[d + 1] = rgba[s + 1];
			pixels[d + 2] = rgba[s];
			pixels[d + 3] = rgba[s + 3];
		}
	}

	// AND-masken ignoreras för 32bpp men måste finnas, radpaddad till 4 byte.
	const maskRow = Math.ceil(size / 32) * 4;
	const mask = Buffer.alloc(maskRow * size);

	return Buffer.concat([header, pixels, mask]);
}

function toIco(sizes: number[]): Buffer {
	const images = sizes.map(size => toIcoBmp(render(size), size));

	const dir = Buffer.alloc(6 + 16 * sizes.length);
	dir.writeUInt16LE(0, 0);
	dir.writeUInt16LE(1, 2); // typ 1 = ikon
	dir.writeUInt16LE(sizes.length, 4);

	let offset = dir.length;
	sizes.forEach((size, i) => {
		const e = 6 + i * 16;
		dir[e] = size >= 256 ? 0 : size; // 0 betyder 256
		dir[e + 1] = size >= 256 ? 0 : size;
		dir[e + 2] = 0; // färger i paletten
		dir[e + 3] = 0;
		dir.writeUInt16LE(1, e + 4);
		dir.writeUInt16LE(32, e + 6);
		dir.writeUInt32LE(images[i].length, e + 8);
		dir.writeUInt32LE(offset, e + 12);
		offset += images[i].length;
	});

	return Buffer.concat([dir, ...images]);
}

const win32 = path.join(ROOT, 'resources', 'win32');

const ico = toIco([16, 24, 32, 48, 64, 128, 256]);
fs.writeFileSync(path.join(win32, 'code.ico'), ico);
console.log(`code.ico: ${ico.length} byte`);

for (const size of [70, 150]) {
	const png = toPng(render(size), size);
	fs.writeFileSync(path.join(win32, `code_${size}x${size}.png`), png);
	console.log(`code_${size}x${size}.png: ${png.length} byte`);
}
