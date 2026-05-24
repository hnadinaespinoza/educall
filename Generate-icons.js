#!/usr/bin/env node
/**
 * generate-icons.js
 * Genera icon-192.png e icon-512.png para la PWA de EduCall.
 * Usa solo módulos nativos de Node.js + Canvas (si disponible) o crea SVG como fallback.
 *
 * Uso: node generate-icons.js
 */

const fs   = require('fs');
const path = require('path');

// SVG del icono de EduCall (fondo gradiente azul + texto 🎓)
function makeSVG(size) {
  const r = Math.round(size * 0.18); // border-radius proporcional
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%"   stop-color="#4f8ef7"/>
      <stop offset="100%" stop-color="#7c5cfc"/>
    </linearGradient>
    <clipPath id="rounded">
      <rect width="${size}" height="${size}" rx="${r}" ry="${r}"/>
    </clipPath>
  </defs>
  <!-- Fondo -->
  <rect width="${size}" height="${size}" rx="${r}" ry="${r}" fill="url(#bg)"/>
  <!-- Ícono de graduación -->
  <text
    x="${size/2}" y="${size * 0.62}"
    font-size="${size * 0.48}"
    text-anchor="middle"
    dominant-baseline="middle"
    font-family="Apple Color Emoji, Segoe UI Emoji, Noto Color Emoji, sans-serif"
  >🎓</text>
  <!-- Nombre abreviado -->
  <text
    x="${size/2}" y="${size * 0.87}"
    font-size="${size * 0.13}"
    font-weight="700"
    text-anchor="middle"
    fill="rgba(255,255,255,0.9)"
    font-family="Outfit, Arial, sans-serif"
    letter-spacing="1"
  >EduCall</text>
</svg>`;
}

// Intentar usar canvas (npm install canvas) si está disponible
async function tryCanvas(size, outPath) {
  try {
    const { createCanvas } = require('canvas');
    const canvas = createCanvas(size, size);
    const ctx    = canvas.getContext('2d');

    const r = Math.round(size * 0.18);

    // Fondo con gradiente
    const grad = ctx.createLinearGradient(0, 0, size, size);
    grad.addColorStop(0,   '#4f8ef7');
    grad.addColorStop(1,   '#7c5cfc');
    ctx.beginPath();
    ctx.moveTo(r, 0);
    ctx.lineTo(size - r, 0);
    ctx.quadraticCurveTo(size, 0, size, r);
    ctx.lineTo(size, size - r);
    ctx.quadraticCurveTo(size, size, size - r, size);
    ctx.lineTo(r, size);
    ctx.quadraticCurveTo(0, size, 0, size - r);
    ctx.lineTo(0, r);
    ctx.quadraticCurveTo(0, 0, r, 0);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    // Emoji
    ctx.font = `${size * 0.48}px Apple Color Emoji, Segoe UI Emoji, sans-serif`;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('🎓', size / 2, size * 0.52);

    // Texto
    ctx.font      = `700 ${size * 0.12}px Outfit, Arial, sans-serif`;
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.fillText('EduCall', size / 2, size * 0.87);

    fs.writeFileSync(outPath, canvas.toBuffer('image/png'));
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const sizes = [192, 512];
  for (const size of sizes) {
    const outPath = path.join(__dirname, `icon-${size}.png`);
    const svgPath = path.join(__dirname, `icon-${size}.svg`);

    // Intentar PNG con canvas
    const ok = await tryCanvas(size, outPath);
    if (ok) {
      console.log(`✅ icon-${size}.png generado`);
    } else {
      // Fallback: guardar SVG (el servidor lo sirve como SVG)
      fs.writeFileSync(svgPath, makeSVG(size));
      console.log(`⚠️  canvas no disponible — se generó icon-${size}.svg`);
      console.log(`   Para PNG: npm install canvas && node generate-icons.js`);
    }
  }
  console.log('\nIconos listos. Ejecuta: node server.js');
}

main().catch(console.error);
