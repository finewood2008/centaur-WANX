// Capture only a bounded area of the trusted Builder WebContents, never the desktop.
async function capturePreview(contents,bounds,input){
 if(!input||Object.keys(input).sort().join(',')!=='height,width,x,y')throw Error('PREVIEW_CAPTURE_INVALID');
 const{x,y,width,height}=input;
 if(![x,y,width,height].every(Number.isSafeInteger)||x<0||y<0||width<20||height<20||x+width>bounds.width||y+height>bounds.height)throw Error('PREVIEW_CAPTURE_INVALID');
 let image=await contents.capturePage({x,y,width,height});
 const size=image.getSize();if(!size.width||!size.height)throw Error('PREVIEW_CAPTURE_FAILED');
 if(size.width>1600||size.height>1600)image=image.resize(size.width>=size.height?{width:1600}:{height:1600});
 const png=image.toPNG();if(png.length>1024*1024)throw Error('PREVIEW_CAPTURE_TOO_LARGE');
 return{image:'data:image/png;base64,'+png.toString('base64'),width:image.getSize().width,height:image.getSize().height,viewport:{width,height}};
}
module.exports={capturePreview};
