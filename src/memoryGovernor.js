import { memoryUsage } from 'node:process';

const MB = 1024 * 1024;

const MEMORY_CEILING_MB = parseInt(process.env.MEMORY_CEILING_MB, 10) || 1024;
const RSS_WALL_OFFSET_MB = parseInt(process.env.RSS_WALL_OFFSET_MB, 10) || 25;
const RSS_ADMISSION_OFFSET_MB = parseInt(process.env.RSS_ADMISSION_OFFSET_MB, 10) || 60;
const PIXEL_MEMORY_DIVISOR = parseInt(process.env.PIXEL_MEMORY_DIVISOR, 10) || 6;
const DOWNLOAD_BYTE_RATIO = parseFloat(process.env.DOWNLOAD_BYTE_RATIO) || 0.35;
const DECOMPRESS_BYTE_RATIO = parseFloat(process.env.DECOMPRESS_BYTE_RATIO) || 0.50;

const RSS_WALL_MB = MEMORY_CEILING_MB - RSS_WALL_OFFSET_MB;
const RSS_ADMISSION_MB = RSS_WALL_MB - RSS_ADMISSION_OFFSET_MB;

let activePixelCost = 0;
let activeByteCost = 0;

function getRssMB() {
  return Math.round(memoryUsage().rss / MB);
}

function getAvailableMB() {
  const rss = getRssMB();
  return Math.max(0, RSS_ADMISSION_MB - rss);
}

function getPixelBudget() {
  const availableMB = getAvailableMB();
  return Math.floor((availableMB * MB) / PIXEL_MEMORY_DIVISOR);
}

function getDownloadBudget() {
  const availableMB = getAvailableMB();
  return Math.floor(availableMB * MB * DOWNLOAD_BYTE_RATIO);
}

function getDecompressBudget() {
  const availableMB = getAvailableMB();
  return Math.floor(availableMB * MB * DECOMPRESS_BYTE_RATIO);
}

function admitPixels(cost) {
  const budget = getPixelBudget();
  if (activePixelCost + cost > budget) return false;
  activePixelCost += cost;
  return true;
}

function releasePixels(cost) {
  activePixelCost = Math.max(0, activePixelCost - cost);
}

function admitBytes(cost) {
  const budget = getDownloadBudget();
  if (activeByteCost + cost > budget) return false;
  activeByteCost += cost;
  return true;
}

function releaseBytes(cost) {
  activeByteCost = Math.max(0, activeByteCost - cost);
}

function isUnderPressure() {
  return getRssMB() > RSS_WALL_MB;
}

function isCritical() {
  return getRssMB() > (MEMORY_CEILING_MB - 10);
}

function getActivePixelCost() {
  return activePixelCost;
}

function getActiveByteCost() {
  return activeByteCost;
}

export default {
  getRssMB,
  getAvailableMB,
  getPixelBudget,
  getDownloadBudget,
  getDecompressBudget,
  admitPixels,
  releasePixels,
  admitBytes,
  releaseBytes,
  isUnderPressure,
  isCritical,
  getActivePixelCost,
  getActiveByteCost,
  MEMORY_CEILING_MB,
  RSS_WALL_MB,
  RSS_ADMISSION_MB
};
