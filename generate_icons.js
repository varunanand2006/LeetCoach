const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const iconsDir = path.join(__dirname, 'extension', 'icons');
const iconSvg = path.join(iconsDir, 'icon.svg');
const icon16Svg = path.join(iconsDir, 'icon-16.svg');

async function generateIcons() {
  try {
    console.log('Generating 16x16 icon...');
    await sharp(icon16Svg)
      .resize(16, 16)
      .png()
      .toFile(path.join(iconsDir, 'icon-16.png'));

    console.log('Generating 48x48 icon...');
    await sharp(iconSvg)
      .resize(48, 48)
      .png()
      .toFile(path.join(iconsDir, 'icon-48.png'));

    console.log('Generating 128x128 icon...');
    await sharp(iconSvg)
      .resize(128, 128)
      .png()
      .toFile(path.join(iconsDir, 'icon-128.png'));

    console.log('Successfully generated all icons!');
  } catch (error) {
    console.error('Error generating icons:', error);
  }
}

generateIcons();
