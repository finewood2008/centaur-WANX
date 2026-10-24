import{sourcePath,validateSources}from'./artifact.mjs';
// Exact, single anchors preserve every byte outside the requested region.
export function patchSource(files,{path,find,replace}){
 sourcePath(path);
 if(!Object.hasOwn(files,path))throw Error('SOURCE_NOT_FOUND');
 if(typeof find!=='string'||!find||typeof replace!=='string')throw Error('PATCH_INPUT_INVALID');
 const old=files[path],at=old.indexOf(find);
 if(at<0)throw Error('SOURCE_CHANGED');
 if(old.indexOf(find,at+1)>=0)throw Error('PATCH_AMBIGUOUS');
 const content=old.slice(0,at)+replace+old.slice(at+find.length);
 validateSources({...files,[path]:content});return content;
}
