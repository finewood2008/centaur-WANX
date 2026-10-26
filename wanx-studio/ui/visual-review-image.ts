import{visualReviewLayout}from'./visual-review-state.mjs';
import type{Capture,CapturePage,AnnotatedRegion}from'./visual-review';
export async function paintReview(pages:CapturePage[],marks:AnnotatedRegion[]):Promise<{capture:Capture;regions:AnnotatedRegion[]}>{
 const layout=visualReviewLayout(pages,marks),canvas=document.createElement('canvas');canvas.width=layout.width;canvas.height=layout.height;
 const ctx=canvas.getContext('2d');if(!ctx)throw Error('PREVIEW_CAPTURE_FAILED');ctx.fillStyle='#faf8f4';ctx.fillRect(0,0,canvas.width,canvas.height);
 const images=await Promise.all(pages.map(page=>new Promise<HTMLImageElement>((resolve,reject)=>{const img=new Image();img.onload=()=>resolve(img);img.onerror=()=>reject(Error('PREVIEW_CAPTURE_FAILED'));img.src=page.image})));
 for(const tile of layout.tiles){const index=pages.findIndex(page=>page.id===tile.pageId),page=pages[index],c=tile.crop;ctx.drawImage(images[index],c.x*page.width,c.y*page.height,c.width*page.width,c.height*page.height,tile.x,tile.y,tile.width,tile.height);if('label' in tile){ctx.fillStyle='#5e584f';ctx.font='18px sans-serif';ctx.fillText('标记 '+tile.label+' · 画面 '+(index+1),(Number(tile.label)-1)%2*800+14,Math.floor((Number(tile.label)-1)/2)*480+25)}}
 ctx.lineWidth=3;ctx.strokeStyle='#b94d2b';ctx.font='bold 18px sans-serif';
 layout.regions.forEach((r:AnnotatedRegion,i:number)=>{const x=r.x*canvas.width,y=r.y*canvas.height;ctx.strokeRect(x,y,r.width*canvas.width,r.height*canvas.height);ctx.fillStyle='#b94d2b';ctx.fillRect(x,y,26,26);ctx.fillStyle='#fff';ctx.fillText(String(i+1),x+7,y+20)});
 // Six crops still use the existing PNG and image-size contract.
 let image=canvas.toDataURL('image/png');while(image.length>1398100&&canvas.width>500){const copy=document.createElement('canvas');copy.width=Math.round(canvas.width*.85);copy.height=Math.round(canvas.height*.85);copy.getContext('2d')!.drawImage(canvas,0,0,copy.width,copy.height);canvas.width=copy.width;canvas.height=copy.height;canvas.getContext('2d')!.drawImage(copy,0,0);image=canvas.toDataURL('image/png')}
 if(image.length>1398100)throw Error('PREVIEW_CAPTURE_TOO_LARGE');
 return{capture:{image,width:canvas.width,height:canvas.height,viewport:{width:canvas.width,height:canvas.height}},regions:layout.regions};
}
