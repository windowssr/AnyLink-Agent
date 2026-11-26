/* Render the existing local model only; no desktop capture or remote traffic. */
(async()=>{
  const send=value=>window.webkit.messageHandlers.brand.postMessage(value);
  try{
    send({type:'stage',stage:'loading-model'});
    const app=new PIXI.Application({width:1024,height:2048,backgroundAlpha:0,antialias:true,preserveDrawingBuffer:true,resolution:1});
    document.body.append(app.view);
    const model=await PIXI.live2d.Live2DModel.from('../model/entry.model3.json',{autoInteract:false});
    model.anchor.set(0.5,0);model.scale.set(Math.min(1000/model.width,2000/model.height));model.position.set(512,12);app.stage.addChild(model);
    // Explicit evaluation works without a visible application window or rAF.
    model.update(1000/60);
    send({type:'stage',stage:'rendering-portrait'});
    app.renderer.render(app.stage);
    const bounds=model.getBounds(),side=bounds.height*0.34;
    const result=document.createElement('canvas');result.width=result.height=512;
    const context=result.getContext('2d');context.fillStyle='#eaf5ff';context.fillRect(0,0,512,512);
    context.drawImage(app.view,bounds.x+bounds.width/2-side/2,bounds.y,side,side,0,0,512,512);
    send({type:'portrait',png:result.toDataURL('image/png').split(',')[1]});
    app.destroy(true,{children:true,texture:true,baseTexture:true});
  }catch{send({type:'error'});}
})();
