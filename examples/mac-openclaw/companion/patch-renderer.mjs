import fs from 'node:fs';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

// Cubism 4's renderer needs the drawable colors supplied by newer Core models.
// Adapted from AIRI's MIT fix: https://github.com/moeru-ai/airi/pull/3323
// Preserve the pinned upstream file and generate a separate compatibility build.
const folder=path.dirname(fileURLToPath(import.meta.url)),lock=JSON.parse(fs.readFileSync(path.join(folder,'runtime-lock.json'),'utf8'));
const upstream=lock.renderer.find(item=>item.package==='pixi-live2d-display');
let source=fs.readFileSync(path.join(folder,'vendor',upstream.file),'utf8');
assert.equal(createHash('sha256').update(source).digest('hex'),upstream.sha256);
function replace(before,after){assert.equal(source.split(before).length-1,1,'Unexpected renderer layout: '+before.slice(0,50));source=source.replace(before,after);}
replace('setupShaderProgram(t,e,i,s,r,a,o,n,l,h,u,d,c){','setupShaderProgram(t,e,i,s,r,a,o,n,l,h,u,d,c,anylinkDrawable){');
replace('this.gl.uniform4f(n.uniformBaseColorLocation,h.R,h.G,h.B,h.A)}','this.gl.uniform4f(n.uniformBaseColorLocation,h.R,h.G,h.B,h.A);const colors=t.getModel()._model.drawables,offset=anylinkDrawable*4;this.gl.uniform4fv(n.uniformMultiplyColorLocation,colors.multiplyColors?colors.multiplyColors.subarray(offset,offset+4):[1,1,1,1]);this.gl.uniform4fv(n.uniformScreenColorLocation,colors.screenColors?colors.screenColors.subarray(offset,offset+4):[0,0,0,0]);}');
replace('this._shaderSets[9].uniformBaseColorLocation=this.gl.getUniformLocation(this._shaderSets[9].shaderProgram,"u_baseColor")}','this._shaderSets[9].uniformBaseColorLocation=this.gl.getUniformLocation(this._shaderSets[9].shaderProgram,"u_baseColor");for(let colorIndex=1;colorIndex<this._shaderSets.length;colorIndex++){const shader=this._shaderSets[colorIndex];shader.uniformMultiplyColorLocation=this.gl.getUniformLocation(shader.shaderProgram,"u_multiplyColor");shader.uniformScreenColorLocation=this.gl.getUniformLocation(shader.shaderProgram,"u_screenColor");}}');
replace('this.getModel().getDrawableInvertedMaskBit(t)))','this.getModel().getDrawableInvertedMaskBit(t),t))');
replace('drawMesh(t,e,i,s,r,a,o,n,l){','drawMesh(t,e,i,s,r,a,o,n,l,anylinkDrawable){');
replace('this.getMvpMatrix(),l),this.gl.drawElements','this.getMvpMatrix(),l,anylinkDrawable),this.gl.drawElements');
let shaders=0;
source=source.replace(/"precision mediump float;[^"\n]+"/g,literal=>{
  if(!/texture2D\(s_texture0\s*,\s*v_texCoord\) \* u_baseColor/.test(literal))return literal;
  shaders++;
  const colored=literal.replace(/texture2D\(s_texture0\s*,\s*v_texCoord\)/g,'anylinkColor');
  return colored.replace('void main(){','uniform vec4 u_multiplyColor;uniform vec4 u_screenColor;void main(){vec4 anylinkColor=texture2D(s_texture0,v_texCoord);anylinkColor.rgb*=u_multiplyColor.rgb;anylinkColor.rgb=anylinkColor.rgb+u_screenColor.rgb*anylinkColor.a-anylinkColor.rgb*u_screenColor.rgb;');
});
assert.equal(shaders,3,'Cover unmasked, masked and inverted-mask fragments');
const output='/* AnyLink drawable color compatibility build; see patch-renderer.mjs and AIRI-LICENSE.txt. */\n'+source;
fs.writeFileSync(path.join(folder,'vendor/cubism4-colors.min.js'),output);
console.log('Generated compatible drawable color renderer (three shader paths).');
