import sharp from 'sharp';
import {readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import path from 'node:path';

// SVG is the only artwork source; platform icons are disposable build outputs.
export async function buildBuilderBrand(root,destination){
 await mkdir(destination,{recursive:true});
 const svg=await readFile(path.join(root,'ui/assets/wanx-builder.svg'));
 await writeFile(path.join(destination,'wanx-builder.svg'),svg);
 const mark=await sharp(svg,{density:1200}).resize(640,640).png().toBuffer();
 const background=Buffer.from('<svg width="1024" height="1024"><rect x="28" y="28" width="968" height="968" rx="216" fill="#f7f2e9" stroke="#e1d4c0" stroke-width="8"/></svg>');
 const icon=await sharp(background).composite([{input:mark,left:192,top:192}]).png().toBuffer();
 await writeFile(path.join(destination,'wanx-builder.png'),icon);
 const sizes=[16,32,48,64,128,256],images=await Promise.all(sizes.map(size=>sharp(icon).resize(size,size).png().toBuffer()));
 const header=Buffer.alloc(6+16*sizes.length);header.writeUInt16LE(1,2);header.writeUInt16LE(sizes.length,4);let offset=header.length;
 images.forEach((image,i)=>{const at=6+i*16;header[at]=header[at+1]=sizes[i]===256?0:sizes[i];header.writeUInt16LE(1,at+4);header.writeUInt16LE(32,at+6);header.writeUInt32LE(image.length,at+8);header.writeUInt32LE(offset,at+12);offset+=image.length});
 await writeFile(path.join(destination,'wanx-builder.ico'),Buffer.concat([header,...images]));
 if(process.platform==='darwin'){
  const set=path.join(destination,'.wanx-builder.iconset');await mkdir(set,{recursive:true});
  try{for(const size of [16,32,128,256,512])for(const scale of [1,2])await sharp(icon).resize(size*scale,size*scale).toFile(path.join(set,`icon_${size}x${size}${scale===2?'@2x':''}.png`));execFileSync('iconutil',['-c','icns','-o',path.join(destination,'wanx-builder.icns'),set])}finally{await rm(set,{recursive:true,force:true})}
 }
}
