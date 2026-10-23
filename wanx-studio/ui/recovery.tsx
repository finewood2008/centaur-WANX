import{Component,type ReactNode}from'react';
import{workspaceRecovery}from'./recovery-state.mjs';
export class BuilderRecovery extends Component<{children:ReactNode},{failed:boolean;busy:boolean;message:string}>{
 state={failed:false,busy:false,message:''};
 componentDidCatch(){workspaceRecovery.arm()}
 static getDerivedStateFromError(){return{failed:true,busy:false,message:''}}
 async reopen(){
  this.setState({busy:true,message:''});
  try{if(window.wanxStudio?.returnToClient){await window.wanxStudio.returnToClient('projects');this.setState({failed:false,busy:false})}else window.location.reload()}
  catch{this.setState({busy:false,message:'连接尚未恢复。请关闭此窗口，从万象的项目列表重新打开。'})}
 }
 render(){return this.state.failed?<main className="builder-recovery" role="alert"><span className="eyebrow">万象 Builder</span><h1>工作台暂时无法显示</h1><p>已保存的方案和版本仍然保留。返回万象，重新打开项目后继续。</p><button className="primary" disabled={this.state.busy} onClick={()=>void this.reopen()}>{this.state.busy?'正在返回…':'返回万象重新打开'}</button>{this.state.message&&<p>{this.state.message}</p>}</main>:this.props.children}
}
