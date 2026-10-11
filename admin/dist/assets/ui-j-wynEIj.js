import{r as u,j as R,R as Ie,a as Ve}from"./react-CTwocyy_.js";/**
 * @license lucide-react v1.25.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const Ct=(...e)=>e.filter((t,n,o)=>!!t&&t.trim()!==""&&o.indexOf(t)===n).join(" ").trim();/**
 * @license lucide-react v1.25.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const gn=e=>e.replace(/([a-z0-9])([A-Z])/g,"$1-$2").toLowerCase();/**
 * @license lucide-react v1.25.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const xn=e=>e.replace(/^([A-Z])|[\s-_]+(\w)/g,(t,n,o)=>o?o.toUpperCase():n.toLowerCase());/**
 * @license lucide-react v1.25.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const at=e=>{const t=xn(e);return t.charAt(0).toUpperCase()+t.slice(1)};/**
 * @license lucide-react v1.25.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */var Oe={xmlns:"http://www.w3.org/2000/svg",width:24,height:24,viewBox:"0 0 24 24",fill:"none",stroke:"currentColor",strokeWidth:2,strokeLinecap:"round",strokeLinejoin:"round"};/**
 * @license lucide-react v1.25.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const wn=e=>{for(const t in e)if(t.startsWith("aria-")||t==="role"||t==="title")return!0;return!1},kn=u.createContext({}),bn=()=>u.useContext(kn),Mn=u.forwardRef(({color:e,size:t,strokeWidth:n,absoluteStrokeWidth:o,className:r="",children:s,iconNode:i,...c},a)=>{const{size:f=24,strokeWidth:l=2,absoluteStrokeWidth:d=!1,color:p="currentColor",className:h=""}=bn()??{},y=o??d?Number(n??l)*24/Number(t??f):n??l;return u.createElement("svg",{ref:a,...Oe,width:t??f??Oe.width,height:t??f??Oe.height,stroke:e??p,strokeWidth:y,className:Ct("lucide",h,r),...!s&&!wn(c)&&{"aria-hidden":"true"},...c},[...i.map(([m,g])=>u.createElement(m,g)),...Array.isArray(s)?s:[s]])});/**
 * @license lucide-react v1.25.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const v=(e,t)=>{const n=u.forwardRef(({className:o,...r},s)=>u.createElement(Mn,{ref:s,iconNode:t,className:Ct(`lucide-${gn(at(e))}`,`lucide-${e}`,o),...r}));return n.displayName=at(e),n};/**
 * @license lucide-react v1.25.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const Cn=[["path",{d:"M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2",key:"169zse"}]],gi=v("activity",Cn);/**
 * @license lucide-react v1.25.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const _n=[["path",{d:"M17 7 7 17",key:"15tmo1"}],["path",{d:"M17 17H7V7",key:"1org7z"}]],xi=v("arrow-down-left",_n);/**
 * @license lucide-react v1.25.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const An=[["path",{d:"m12 19-7-7 7-7",key:"1l729n"}],["path",{d:"M19 12H5",key:"x3x0zl"}]],wi=v("arrow-left",An);/**
 * @license lucide-react v1.25.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const Rn=[["path",{d:"M5 12h14",key:"1ays0h"}],["path",{d:"m12 5 7 7-7 7",key:"xquz4c"}]],ki=v("arrow-right",Rn);/**
 * @license lucide-react v1.25.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const En=[["path",{d:"M7 7h10v10",key:"1tivn9"}],["path",{d:"M7 17 17 7",key:"1vkiza"}]],bi=v("arrow-up-right",En);/**
 * @license lucide-react v1.25.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const Pn=[["path",{d:"m5 12 7-7 7 7",key:"hav0vg"}],["path",{d:"M12 19V5",key:"x0mq9r"}]],Mi=v("arrow-up",Pn);/**
 * @license lucide-react v1.25.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const Nn=[["path",{d:"M12 7v14",key:"1akyts"}],["path",{d:"M16 12h2",key:"7q9ll5"}],["path",{d:"M16 8h2",key:"msurwy"}],["path",{d:"M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z",key:"ruj8y"}],["path",{d:"M6 12h2",key:"32wvfc"}],["path",{d:"M6 8h2",key:"30oboj"}]],Ci=v("book-open-text",Nn);/**
 * @license lucide-react v1.25.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const On=[["path",{d:"M12 7v14",key:"1akyts"}],["path",{d:"M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z",key:"ruj8y"}]],_i=v("book-open",On);/**
 * @license lucide-react v1.25.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const Sn=[["path",{d:"M12 8V4H8",key:"hb8ula"}],["rect",{width:"16",height:"12",x:"4",y:"8",rx:"2",key:"enze0r"}],["path",{d:"M2 14h2",key:"vft8re"}],["path",{d:"M20 14h2",key:"4cs60a"}],["path",{d:"M15 13v2",key:"1xurst"}],["path",{d:"M9 13v2",key:"rq6x2g"}]],Ai=v("bot",Sn);/**
 * @license lucide-react v1.25.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const Tn=[["path",{d:"M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z",key:"hh9hay"}],["path",{d:"m3.3 7 8.7 5 8.7-5",key:"g66t2b"}],["path",{d:"M12 22V12",key:"d0xqtd"}]],Ri=v("box",Tn);/**
 * @license lucide-react v1.25.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const $n=[["path",{d:"M2.97 12.92A2 2 0 0 0 2 14.63v3.24a2 2 0 0 0 .97 1.71l3 1.8a2 2 0 0 0 2.06 0L12 19v-5.5l-5-3-4.03 2.42Z",key:"lc1i9w"}],["path",{d:"m7 16.5-4.74-2.85",key:"1o9zyk"}],["path",{d:"m7 16.5 5-3",key:"va8pkn"}],["path",{d:"M7 16.5v5.17",key:"jnp8gn"}],["path",{d:"M12 13.5V19l3.97 2.38a2 2 0 0 0 2.06 0l3-1.8a2 2 0 0 0 .97-1.71v-3.24a2 2 0 0 0-.97-1.71L17 10.5l-5 3Z",key:"8zsnat"}],["path",{d:"m17 16.5-5-3",key:"8arw3v"}],["path",{d:"m17 16.5 4.74-2.85",key:"8rfmw"}],["path",{d:"M17 16.5v5.17",key:"k6z78m"}],["path",{d:"M7.97 4.42A2 2 0 0 0 7 6.13v4.37l5 3 5-3V6.13a2 2 0 0 0-.97-1.71l-3-1.8a2 2 0 0 0-2.06 0l-3 1.8Z",key:"1xygjf"}],["path",{d:"M12 8 7.26 5.15",key:"1vbdud"}],["path",{d:"m12 8 4.74-2.85",key:"3rx089"}],["path",{d:"M12 13.5V8",key:"1io7kd"}]],Ei=v("boxes",$n);/**
 * @license lucide-react v1.25.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const Ln=[["path",{d:"M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z",key:"l5xja"}],["path",{d:"M9 13a4.5 4.5 0 0 0 3-4",key:"10igwf"}],["path",{d:"M6.003 5.125A3 3 0 0 0 6.401 6.5",key:"105sqy"}],["path",{d:"M3.477 10.896a4 4 0 0 1 .585-.396",key:"ql3yin"}],["path",{d:"M6 18a4 4 0 0 1-1.967-.516",key:"2e4loj"}],["path",{d:"M12 13h4",key:"1ku699"}],["path",{d:"M12 18h6a2 2 0 0 1 2 2v1",key:"105ag5"}],["path",{d:"M12 8h8",key:"1lhi5i"}],["path",{d:"M16 8V5a2 2 0 0 1 2-2",key:"u6izg6"}],["circle",{cx:"16",cy:"13",r:".5",key:"ry7gng"}],["circle",{cx:"18",cy:"3",r:".5",key:"1aiba7"}],["circle",{cx:"20",cy:"21",r:".5",key:"yhc1fs"}],["circle",{cx:"20",cy:"8",r:".5",key:"1e43v0"}]],Pi=v("brain-circuit",Ln);/**
 * @license lucide-react v1.25.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const Dn=[["path",{d:"M17 19a1 1 0 0 1-1-1v-2a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2a1 1 0 0 1-1 1z",key:"trhst0"}],["path",{d:"M17 21v-2",key:"ds4u3f"}],["path",{d:"M19 14V6.5a1 1 0 0 0-7 0v11a1 1 0 0 1-7 0V10",key:"1mo9zo"}],["path",{d:"M21 21v-2",key:"eo0ou"}],["path",{d:"M3 5V3",key:"1k5hjh"}],["path",{d:"M4 10a2 2 0 0 1-2-2V6a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2a2 2 0 0 1-2 2z",key:"1dd30t"}],["path",{d:"M7 5V3",key:"1t1388"}]],Ni=v("cable",Dn);/**
 * @license lucide-react v1.25.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const jn=[["path",{d:"M20 6 9 17l-5-5",key:"1gmf2c"}]],Oi=v("check",jn);/**
 * @license lucide-react v1.25.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const zn=[["path",{d:"m6 9 6 6 6-6",key:"qrunsl"}]],Si=v("chevron-down",zn);/**
 * @license lucide-react v1.25.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const Hn=[["path",{d:"m9 18 6-6-6-6",key:"mthhwq"}]],Ti=v("chevron-right",Hn);/**
 * @license lucide-react v1.25.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const In=[["circle",{cx:"12",cy:"12",r:"10",key:"1mglay"}],["line",{x1:"12",x2:"12",y1:"8",y2:"12",key:"1pkeuh"}],["line",{x1:"12",x2:"12.01",y1:"16",y2:"16",key:"4dfq90"}]],$i=v("circle-alert",In);/**
 * @license lucide-react v1.25.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const Vn=[["circle",{cx:"12",cy:"12",r:"10",key:"1mglay"}],["path",{d:"m9 12 2 2 4-4",key:"dzmm74"}]],Li=v("circle-check",Vn);/**
 * @license lucide-react v1.25.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const Wn=[["path",{d:"M10.1 2.182a10 10 0 0 1 3.8 0",key:"5ilxe3"}],["path",{d:"M13.9 21.818a10 10 0 0 1-3.8 0",key:"11zvb9"}],["path",{d:"M17.609 3.721a10 10 0 0 1 2.69 2.7",key:"1iw5b2"}],["path",{d:"M2.182 13.9a10 10 0 0 1 0-3.8",key:"c0bmvh"}],["path",{d:"M20.279 17.609a10 10 0 0 1-2.7 2.69",key:"1ruxm7"}],["path",{d:"M21.818 10.1a10 10 0 0 1 0 3.8",key:"qkgqxc"}],["path",{d:"M3.721 6.391a10 10 0 0 1 2.7-2.69",key:"1mcia2"}],["path",{d:"M6.391 20.279a10 10 0 0 1-2.69-2.7",key:"1fvljs"}]],Di=v("circle-dashed",Wn);/**
 * @license lucide-react v1.25.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const Fn=[["circle",{cx:"12",cy:"12",r:"10",key:"1mglay"}],["circle",{cx:"12",cy:"12",r:"1",key:"41hilf"}]],ji=v("circle-dot",Fn);/**
 * @license lucide-react v1.25.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const qn=[["circle",{cx:"12",cy:"12",r:"10",key:"1mglay"}],["path",{d:"M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3",key:"1u773s"}],["path",{d:"M12 17h.01",key:"p32p05"}]],zi=v("circle-question-mark",qn);/**
 * @license lucide-react v1.25.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const Bn=[["circle",{cx:"12",cy:"12",r:"10",key:"1mglay"}],["rect",{x:"9",y:"9",width:"6",height:"6",rx:"1",key:"1ssd4o"}]],Hi=v("circle-stop",Bn);/**
 * @license lucide-react v1.25.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const Un=[["circle",{cx:"12",cy:"12",r:"10",key:"1mglay"}],["path",{d:"m15 9-6 6",key:"1uzhvr"}],["path",{d:"m9 9 6 6",key:"z0biqf"}]],Ii=v("circle-x",Un);/**
 * @license lucide-react v1.25.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const Yn=[["circle",{cx:"12",cy:"12",r:"10",key:"1mglay"}]],Vi=v("circle",Yn);/**
 * @license lucide-react v1.25.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const Xn=[["circle",{cx:"12",cy:"12",r:"10",key:"1mglay"}],["path",{d:"M12 6v6h4",key:"135r8i"}]],Wi=v("clock-3",Xn);/**
 * @license lucide-react v1.25.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const Zn=[["rect",{width:"14",height:"14",x:"8",y:"8",rx:"2",ry:"2",key:"17jyea"}],["path",{d:"M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2",key:"zix9uf"}]],Fi=v("copy",Zn);/**
 * @license lucide-react v1.25.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const Gn=[["path",{d:"M12 20v2",key:"1lh1kg"}],["path",{d:"M12 2v2",key:"tus03m"}],["path",{d:"M17 20v2",key:"1rnc9c"}],["path",{d:"M17 2v2",key:"11trls"}],["path",{d:"M2 12h2",key:"1t8f8n"}],["path",{d:"M2 17h2",key:"7oei6x"}],["path",{d:"M2 7h2",key:"asdhe0"}],["path",{d:"M20 12h2",key:"1q8mjw"}],["path",{d:"M20 17h2",key:"1fpfkl"}],["path",{d:"M20 7h2",key:"1o8tra"}],["path",{d:"M7 20v2",key:"4gnj0m"}],["path",{d:"M7 2v2",key:"1i4yhu"}],["rect",{x:"4",y:"4",width:"16",height:"16",rx:"2",key:"1vbyd7"}],["rect",{x:"8",y:"8",width:"8",height:"8",rx:"1",key:"z9xiuo"}]],qi=v("cpu",Gn);/**
 * @license lucide-react v1.25.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const Kn=[["ellipse",{cx:"12",cy:"5",rx:"9",ry:"3",key:"msslwz"}],["path",{d:"M3 5V19A9 3 0 0 0 21 19V5",key:"1wlel7"}],["path",{d:"M3 12A9 3 0 0 0 21 12",key:"mv7ke4"}]],Bi=v("database",Kn);/**
 * @license lucide-react v1.25.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const Qn=[["path",{d:"M12 15V3",key:"m9g1x1"}],["path",{d:"M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4",key:"ih7n3h"}],["path",{d:"m7 10 5 5 5-5",key:"brsn70"}]],Ui=v("download",Qn);/**
 * @license lucide-react v1.25.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const Jn=[["path",{d:"m15 15 6 6",key:"1s409w"}],["path",{d:"m15 9 6-6",key:"ko1vev"}],["path",{d:"M21 16v5h-5",key:"1ck2sf"}],["path",{d:"M21 8V3h-5",key:"1qoq8a"}],["path",{d:"M3 16v5h5",key:"1t08am"}],["path",{d:"m3 21 6-6",key:"wwnumi"}],["path",{d:"M3 8V3h5",key:"1ln10m"}],["path",{d:"M9 9 3 3",key:"v551iv"}]],Yi=v("expand",Jn);/**
 * @license lucide-react v1.25.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const eo=[["path",{d:"M15 3h6v6",key:"1q9fwt"}],["path",{d:"M10 14 21 3",key:"gplh6r"}],["path",{d:"M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6",key:"a6xqqp"}]],Xi=v("external-link",eo);/**
 * @license lucide-react v1.25.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const to=[["path",{d:"M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0",key:"1nclc0"}],["circle",{cx:"12",cy:"12",r:"3",key:"1v7zrd"}]],Zi=v("eye",to);/**
 * @license lucide-react v1.25.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const no=[["path",{d:"M16 22h2a2 2 0 0 0 2-2V8a2.4 2.4 0 0 0-.706-1.706l-3.588-3.588A2.4 2.4 0 0 0 14 2H6a2 2 0 0 0-2 2v2.85",key:"ryk6xj"}],["path",{d:"M14 2v5a1 1 0 0 0 1 1h5",key:"wfsgrz"}],["path",{d:"M8 14v2.2l1.6 1",key:"6m4bie"}],["circle",{cx:"8",cy:"16",r:"6",key:"10v15b"}]],Gi=v("file-clock",no);/**
 * @license lucide-react v1.25.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const oo=[["path",{d:"M11.35 22H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.706.706l3.588 3.588A2.4 2.4 0 0 1 20 8v5.35",key:"17jvcc"}],["path",{d:"M14 2v5a1 1 0 0 0 1 1h5",key:"wfsgrz"}],["path",{d:"M14 19h6",key:"bvotb8"}],["path",{d:"M17 16v6",key:"18yu1i"}]],Ki=v("file-plus-corner",oo);/**
 * @license lucide-react v1.25.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const ro=[["path",{d:"M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z",key:"1oefj6"}],["path",{d:"M14 2v5a1 1 0 0 0 1 1h5",key:"wfsgrz"}],["path",{d:"M10 9H8",key:"b1mrlr"}],["path",{d:"M16 13H8",key:"t4e002"}],["path",{d:"M16 17H8",key:"z1uh3a"}]],Qi=v("file-text",ro);/**
 * @license lucide-react v1.25.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const so=[["path",{d:"M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z",key:"1oefj6"}],["path",{d:"M14 2v5a1 1 0 0 0 1 1h5",key:"wfsgrz"}],["path",{d:"M12 12v6",key:"3ahymv"}],["path",{d:"m15 15-3-3-3 3",key:"15xj92"}]],Ji=v("file-up",so);/**
 * @license lucide-react v1.25.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const io=[["path",{d:"M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z",key:"1fr9dc"}],["path",{d:"M8 10v4",key:"tgpxqk"}],["path",{d:"M12 10v2",key:"hh53o1"}],["path",{d:"M16 10v6",key:"1d6xys"}]],ec=v("folder-kanban",io);/**
 * @license lucide-react v1.25.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const co=[["path",{d:"M12 10v6",key:"1bos4e"}],["path",{d:"M9 13h6",key:"1uhe8q"}],["path",{d:"M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z",key:"1kt360"}]],tc=v("folder-plus",co);/**
 * @license lucide-react v1.25.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const ao=[["path",{d:"M20 10a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1h-2.5a1 1 0 0 1-.8-.4l-.9-1.2A1 1 0 0 0 15 3h-2a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1Z",key:"hod4my"}],["path",{d:"M20 21a1 1 0 0 0 1-1v-3a1 1 0 0 0-1-1h-2.9a1 1 0 0 1-.88-.55l-.42-.85a1 1 0 0 0-.92-.6H13a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1Z",key:"w4yl2u"}],["path",{d:"M3 5a2 2 0 0 0 2 2h3",key:"f2jnh7"}],["path",{d:"M3 3v13a2 2 0 0 0 2 2h3",key:"k8epm1"}]],nc=v("folder-tree",ao);/**
 * @license lucide-react v1.25.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const lo=[["path",{d:"M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z",key:"1kt360"}]],oc=v("folder",lo);/**
 * @license lucide-react v1.25.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const uo=[["circle",{cx:"12",cy:"12",r:"10",key:"1mglay"}],["path",{d:"M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20",key:"13o1zl"}],["path",{d:"M2 12h20",key:"9i4pu4"}]],rc=v("globe",uo);/**
 * @license lucide-react v1.25.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const fo=[["path",{d:"M19.414 14.414C21 12.828 22 11.5 22 9.5a5.5 5.5 0 0 0-9.591-3.676.6.6 0 0 1-.818.001A5.5 5.5 0 0 0 2 9.5c0 2.3 1.5 4 3 5.5l5.535 5.362a2 2 0 0 0 2.879.052 2.12 2.12 0 0 0-.004-3 2.124 2.124 0 1 0 3-3 2.124 2.124 0 0 0 3.004 0 2 2 0 0 0 0-2.828l-1.881-1.882a2.41 2.41 0 0 0-3.409 0l-1.71 1.71a2 2 0 0 1-2.828 0 2 2 0 0 1 0-2.828l2.823-2.762",key:"17lmqv"}]],sc=v("heart-handshake",fo);/**
 * @license lucide-react v1.25.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const ho=[["path",{d:"M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8",key:"1357e3"}],["path",{d:"M3 3v5h5",key:"1xhq8a"}],["path",{d:"M12 7v5l4 2",key:"1fdv2h"}]],ic=v("history",ho);/**
 * @license lucide-react v1.25.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const po=[["path",{d:"M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8",key:"5wwlr5"}],["path",{d:"M3 10a2 2 0 0 1 .709-1.528l7-6a2 2 0 0 1 2.582 0l7 6A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",key:"r6nss1"}]],cc=v("house",po);/**
 * @license lucide-react v1.25.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const yo=[["path",{d:"M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z",key:"1s6t7t"}],["circle",{cx:"16.5",cy:"7.5",r:".5",fill:"currentColor",key:"w0ekpg"}]],ac=v("key-round",yo);/**
 * @license lucide-react v1.25.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const mo=[["path",{d:"M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z",key:"zw3jo"}],["path",{d:"M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12",key:"1wduqc"}],["path",{d:"M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17",key:"kqbvx6"}]],lc=v("layers",mo);/**
 * @license lucide-react v1.25.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const vo=[["rect",{width:"7",height:"9",x:"3",y:"3",rx:"1",key:"10lvy0"}],["rect",{width:"7",height:"5",x:"14",y:"3",rx:"1",key:"16une8"}],["rect",{width:"7",height:"9",x:"14",y:"12",rx:"1",key:"1hutg5"}],["rect",{width:"7",height:"5",x:"3",y:"16",rx:"1",key:"ldoo1y"}]],dc=v("layout-dashboard",vo);/**
 * @license lucide-react v1.25.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const go=[["path",{d:"M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71",key:"1cjeqo"}],["path",{d:"M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71",key:"19qd67"}]],uc=v("link",go);/**
 * @license lucide-react v1.25.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const xo=[["path",{d:"M9 17H7A5 5 0 0 1 7 7h2",key:"8i5ue5"}],["path",{d:"M15 7h2a5 5 0 1 1 0 10h-2",key:"1b9ql8"}],["line",{x1:"8",x2:"16",y1:"12",y2:"12",key:"1jonct"}]],fc=v("link-2",xo);/**
 * @license lucide-react v1.25.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const wo=[["path",{d:"M13 5h8",key:"a7qcls"}],["path",{d:"M13 12h8",key:"h98zly"}],["path",{d:"M13 19h8",key:"c3s6r1"}],["path",{d:"m3 17 2 2 4-4",key:"1jhpwq"}],["rect",{x:"3",y:"4",width:"6",height:"6",rx:"1",key:"cif1o7"}]],hc=v("list-todo",wo);/**
 * @license lucide-react v1.25.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const ko=[["path",{d:"M21 12a9 9 0 1 1-6.219-8.56",key:"13zald"}]],pc=v("loader-circle",ko);/**
 * @license lucide-react v1.25.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const bo=[["line",{x1:"2",x2:"5",y1:"12",y2:"12",key:"bvdh0s"}],["line",{x1:"19",x2:"22",y1:"12",y2:"12",key:"1tbv5k"}],["line",{x1:"12",x2:"12",y1:"2",y2:"5",key:"11lu5j"}],["line",{x1:"12",x2:"12",y1:"19",y2:"22",key:"x3vr5v"}],["circle",{cx:"12",cy:"12",r:"7",key:"fim9np"}],["circle",{cx:"12",cy:"12",r:"3",key:"1v7zrd"}]],yc=v("locate-fixed",bo);/**
 * @license lucide-react v1.25.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const Mo=[["path",{d:"M15 3h6v6",key:"1q9fwt"}],["path",{d:"m21 3-7 7",key:"1l2asr"}],["path",{d:"m3 21 7-7",key:"tjx5ai"}],["path",{d:"M9 21H3v-6",key:"wtvkvv"}]],mc=v("maximize-2",Mo);/**
 * @license lucide-react v1.25.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const Co=[["path",{d:"M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719",key:"1sd12s"}]],vc=v("message-circle",Co);/**
 * @license lucide-react v1.25.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const _o=[["path",{d:"m14 10 7-7",key:"oa77jy"}],["path",{d:"M20 10h-6V4",key:"mjg0md"}],["path",{d:"m3 21 7-7",key:"tjx5ai"}],["path",{d:"M4 14h6v6",key:"rmj7iw"}]],gc=v("minimize-2",_o);/**
 * @license lucide-react v1.25.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const Ao=[["path",{d:"M5 12h14",key:"1ays0h"}]],xc=v("minus",Ao);/**
 * @license lucide-react v1.25.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const Ro=[["path",{d:"M12 17v4",key:"1riwvh"}],["path",{d:"m14.305 7.53.923-.382",key:"1mlnsw"}],["path",{d:"m15.228 4.852-.923-.383",key:"82mpwg"}],["path",{d:"m16.852 3.228-.383-.924",key:"ln4sir"}],["path",{d:"m16.852 8.772-.383.923",key:"1dejw0"}],["path",{d:"m19.148 3.228.383-.924",key:"192kgf"}],["path",{d:"m19.53 9.696-.382-.924",key:"fiavlr"}],["path",{d:"m20.772 4.852.924-.383",key:"1j8mgp"}],["path",{d:"m20.772 7.148.924.383",key:"zix9be"}],["path",{d:"M22 13v2a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7",key:"1tnzv8"}],["path",{d:"M8 21h8",key:"1ev6f3"}],["circle",{cx:"18",cy:"6",r:"3",key:"1h7g24"}]],wc=v("monitor-cog",Ro);/**
 * @license lucide-react v1.25.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const Eo=[["rect",{width:"20",height:"14",x:"2",y:"3",rx:"2",key:"48i651"}],["line",{x1:"8",x2:"16",y1:"21",y2:"21",key:"1svkeh"}],["line",{x1:"12",x2:"12",y1:"17",y2:"21",key:"vw1qmm"}]],kc=v("monitor",Eo);/**
 * @license lucide-react v1.25.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const Po=[["path",{d:"M4.037 4.688a.495.495 0 0 1 .651-.651l16 6.5a.5.5 0 0 1-.063.947l-6.124 1.58a2 2 0 0 0-1.438 1.435l-1.579 6.126a.5.5 0 0 1-.947.063z",key:"edeuup"}]],bc=v("mouse-pointer-2",Po);/**
 * @license lucide-react v1.25.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const No=[["rect",{x:"16",y:"16",width:"6",height:"6",rx:"1",key:"4q2zg0"}],["rect",{x:"2",y:"16",width:"6",height:"6",rx:"1",key:"8cvhb9"}],["rect",{x:"9",y:"2",width:"6",height:"6",rx:"1",key:"1egb70"}],["path",{d:"M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3",key:"1jsf9p"}],["path",{d:"M12 12V8",key:"2874zd"}]],Mc=v("network",No);/**
 * @license lucide-react v1.25.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const Oo=[["path",{d:"M20.341 6.484A10 10 0 0 1 10.266 21.85",key:"1enhxb"}],["path",{d:"M3.659 17.516A10 10 0 0 1 13.74 2.152",key:"1crzgf"}],["circle",{cx:"12",cy:"12",r:"3",key:"1v7zrd"}],["circle",{cx:"19",cy:"5",r:"2",key:"mhkx31"}],["circle",{cx:"5",cy:"19",r:"2",key:"v8kfzx"}]],Cc=v("orbit",Oo);/**
 * @license lucide-react v1.25.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const So=[["rect",{width:"18",height:"18",x:"3",y:"3",rx:"2",key:"afitv7"}],["path",{d:"M9 3v18",key:"fh3hqa"}],["path",{d:"m16 15-3-3 3-3",key:"14y99z"}]],_c=v("panel-left-close",So);/**
 * @license lucide-react v1.25.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const To=[["rect",{width:"18",height:"18",x:"3",y:"3",rx:"2",key:"afitv7"}],["path",{d:"M9 3v18",key:"fh3hqa"}],["path",{d:"m14 9 3 3-3 3",key:"8010ee"}]],Ac=v("panel-left-open",To);/**
 * @license lucide-react v1.25.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const $o=[["path",{d:"M13 21h8",key:"1jsn5i"}],["path",{d:"M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z",key:"1a8usu"}]],Rc=v("pen-line",$o);/**
 * @license lucide-react v1.25.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const Lo=[["path",{d:"M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z",key:"1a8usu"}],["path",{d:"m15 5 4 4",key:"1mk7zo"}]],Ec=v("pencil",Lo);/**
 * @license lucide-react v1.25.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const Do=[["path",{d:"M5 12h14",key:"1ays0h"}],["path",{d:"M12 5v14",key:"s699le"}]],Pc=v("plus",Do);/**
 * @license lucide-react v1.25.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const jo=[["path",{d:"M12 2v10",key:"mnfbl"}],["path",{d:"M18.4 6.6a9 9 0 1 1-12.77.04",key:"obofu9"}]],Nc=v("power",jo);/**
 * @license lucide-react v1.25.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const zo=[["path",{d:"M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8",key:"v9h5vc"}],["path",{d:"M21 3v5h-5",key:"1q7to0"}],["path",{d:"M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16",key:"3uifl3"}],["path",{d:"M8 16H3v5",key:"1cv678"}]],Oc=v("refresh-cw",zo);/**
 * @license lucide-react v1.25.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const Ho=[["path",{d:"m21 21-4.34-4.34",key:"14j7rj"}],["circle",{cx:"11",cy:"11",r:"8",key:"4ej97u"}]],Sc=v("search",Ho);/**
 * @license lucide-react v1.25.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const Io=[["path",{d:"M14 17H5",key:"gfn3mx"}],["path",{d:"M19 7h-9",key:"6i9tg"}],["circle",{cx:"17",cy:"17",r:"3",key:"18b49y"}],["circle",{cx:"7",cy:"7",r:"3",key:"dfmy0x"}]],Tc=v("settings-2",Io);/**
 * @license lucide-react v1.25.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const Vo=[["path",{d:"M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915",key:"1i5ecw"}],["circle",{cx:"12",cy:"12",r:"3",key:"1v7zrd"}]],$c=v("settings",Vo);/**
 * @license lucide-react v1.25.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const Wo=[["path",{d:"M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z",key:"oel41y"}],["path",{d:"M12 8v4",key:"1got3b"}],["path",{d:"M12 16h.01",key:"1drbdi"}]],Lc=v("shield-alert",Wo);/**
 * @license lucide-react v1.25.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const Fo=[["path",{d:"M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z",key:"oel41y"}],["path",{d:"m9 12 2 2 4-4",key:"dzmm74"}]],Dc=v("shield-check",Fo);/**
 * @license lucide-react v1.25.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const qo=[["path",{d:"M10 5H3",key:"1qgfaw"}],["path",{d:"M12 19H3",key:"yhmn1j"}],["path",{d:"M14 3v4",key:"1sua03"}],["path",{d:"M16 17v4",key:"1q0r14"}],["path",{d:"M21 12h-9",key:"1o4lsq"}],["path",{d:"M21 19h-5",key:"1rlt1p"}],["path",{d:"M21 5h-7",key:"1oszz2"}],["path",{d:"M8 10v4",key:"tgpxqk"}],["path",{d:"M8 12H3",key:"a7s4jb"}]],jc=v("sliders-horizontal",qo);/**
 * @license lucide-react v1.25.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const Bo=[["path",{d:"M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z",key:"1s2grr"}],["path",{d:"M20 2v4",key:"1rf3ol"}],["path",{d:"M22 4h-4",key:"gwowj6"}],["circle",{cx:"4",cy:"20",r:"2",key:"6kqj1y"}]],zc=v("sparkles",Bo);/**
 * @license lucide-react v1.25.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const Uo=[["rect",{width:"18",height:"18",x:"3",y:"3",rx:"2",key:"afitv7"}]],Hc=v("square",Uo);/**
 * @license lucide-react v1.25.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const Yo=[["path",{d:"M13.172 2a2 2 0 0 1 1.414.586l6.71 6.71a2.4 2.4 0 0 1 0 3.408l-4.592 4.592a2.4 2.4 0 0 1-3.408 0l-6.71-6.71A2 2 0 0 1 6 9.172V3a1 1 0 0 1 1-1z",key:"16rjxf"}],["path",{d:"M2 7v6.172a2 2 0 0 0 .586 1.414l6.71 6.71a2.4 2.4 0 0 0 3.191.193",key:"178nd4"}],["circle",{cx:"10.5",cy:"6.5",r:".5",fill:"currentColor",key:"12ikhr"}]],Ic=v("tags",Yo);/**
 * @license lucide-react v1.25.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const Xo=[["path",{d:"M10 11v6",key:"nco0om"}],["path",{d:"M14 11v6",key:"outv1u"}],["path",{d:"M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6",key:"miytrc"}],["path",{d:"M3 6h18",key:"d0wm0j"}],["path",{d:"M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2",key:"e791ji"}]],Vc=v("trash-2",Xo);/**
 * @license lucide-react v1.25.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const Zo=[["path",{d:"m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3",key:"wmoenq"}],["path",{d:"M12 9v4",key:"juzpu7"}],["path",{d:"M12 17h.01",key:"p32p05"}]],Wc=v("triangle-alert",Zo);/**
 * @license lucide-react v1.25.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const Go=[["path",{d:"M12 3v12",key:"1x0j5s"}],["path",{d:"m17 8-5-5-5 5",key:"7q97r8"}],["path",{d:"M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4",key:"ih7n3h"}]],Fc=v("upload",Go);/**
 * @license lucide-react v1.25.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const Ko=[["path",{d:"M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2",key:"975kel"}],["circle",{cx:"12",cy:"7",r:"4",key:"17ys0d"}]],qc=v("user",Ko);/**
 * @license lucide-react v1.25.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const Qo=[["path",{d:"m10.586 5.414-5.172 5.172",key:"4mc350"}],["path",{d:"m18.586 13.414-5.172 5.172",key:"8c96vv"}],["path",{d:"M6 12h12",key:"8npq4p"}],["circle",{cx:"12",cy:"20",r:"2",key:"144qzu"}],["circle",{cx:"12",cy:"4",r:"2",key:"muu5ef"}],["circle",{cx:"20",cy:"12",r:"2",key:"1xzzfp"}],["circle",{cx:"4",cy:"12",r:"2",key:"1hvhnz"}]],Bc=v("waypoints",Qo);/**
 * @license lucide-react v1.25.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const Jo=[["path",{d:"M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.106-3.105c.32-.322.863-.22.983.218a6 6 0 0 1-8.259 7.057l-7.91 7.91a1 1 0 0 1-2.999-3l7.91-7.91a6 6 0 0 1 7.057-8.259c.438.12.54.662.219.984z",key:"1ngwbx"}]],Uc=v("wrench",Jo);/**
 * @license lucide-react v1.25.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const er=[["path",{d:"M18 6 6 18",key:"1bl5f8"}],["path",{d:"m6 6 12 12",key:"d8bk6v"}]],Yc=v("x",er);function q(e,t,{checkForDefaultPrevented:n=!0}={}){return function(r){if(e==null||e(r),n===!1||!r||!r.defaultPrevented)return t==null?void 0:t(r)}}function lt(e,t){if(typeof e=="function")return e(t);e!=null&&(e.current=t)}function tr(...e){return t=>{let n=!1;const o=e.map(r=>{const s=lt(r,t);return!n&&typeof s=="function"&&(n=!0),s});if(n)return()=>{for(let r=0;r<o.length;r++){const s=o[r];typeof s=="function"?s():lt(e[r],null)}}}}function oe(...e){return u.useCallback(tr(...e),e)}function _t(e,t=[]){let n=[];function o(s,i){const c=u.createContext(i);c.displayName=s+"Context";const a=n.length;n=[...n,i];const f=d=>{var x;const{scope:p,children:h,...y}=d,m=((x=p==null?void 0:p[e])==null?void 0:x[a])||c,g=u.useMemo(()=>y,Object.values(y));return R.jsx(m.Provider,{value:g,children:h})};f.displayName=s+"Provider";function l(d,p,h={}){var x;const{optional:y=!1}=h,m=((x=p==null?void 0:p[e])==null?void 0:x[a])||c,g=u.useContext(m);if(g)return g;if(i!==void 0)return i;if(!y)throw new Error(`\`${d}\` must be used within \`${s}\``)}return[f,l]}const r=()=>{const s=n.map(i=>u.createContext(i));return function(c){const a=(c==null?void 0:c[e])||s;return u.useMemo(()=>({[`__scope${e}`]:{...c,[e]:a}}),[c,a])}};return r.scopeName=e,[o,nr(r,...t)]}function nr(...e){const t=e[0];if(e.length===1)return t;const n=()=>{const o=e.map(r=>({useScope:r(),scopeName:r.scopeName}));return function(s){const i=o.reduce((c,{useScope:a,scopeName:f})=>{const d=a(s)[`__scope${f}`];return{...c,...d}},{});return u.useMemo(()=>({[`__scope${t.scopeName}`]:i}),[i])}};return n.scopeName=t.scopeName,n}function or(e){const t=u.forwardRef((n,o)=>{let{children:r,...s}=n,i=null,c=!1;const a=[];dt(r)&&typeof ye=="function"&&(r=ye(r._payload)),u.Children.forEach(r,p=>{var h;if(ar(p)){c=!0;const y=p;let m="child"in y.props?y.props.child:y.props.children;dt(m)&&typeof ye=="function"&&(m=ye(m._payload)),i=sr(y,m),a.push((h=i==null?void 0:i.props)==null?void 0:h.children)}else a.push(p)}),i?i=u.cloneElement(i,void 0,a):!c&&u.Children.count(r)===1&&u.isValidElement(r)&&(i=r);const f=i?cr(i):void 0,l=oe(o,f);if(!i){if(r||r===0)throw new Error(c?fr(e):ur(e));return r}const d=ir(s,i.props??{});return i.type!==u.Fragment&&(d.ref=o?l:f),u.cloneElement(i,d)});return t.displayName=`${e}.Slot`,t}var At=Symbol.for("radix.slottable");function rr(e){const t=n=>"child"in n?n.children(n.child):n.children;return t.displayName=`${e}.Slottable`,t.__radixId=At,t}var sr=(e,t)=>{if("child"in e.props){const n=e.props.child;return u.isValidElement(n)?u.cloneElement(n,void 0,e.props.children(n.props.children)):null}return u.isValidElement(t)?t:null};function ir(e,t){const n={...t};for(const o in t){const r=e[o],s=t[o];/^on[A-Z]/.test(o)?r&&s?n[o]=(...c)=>{const a=s(...c);return r(...c),a}:r&&(n[o]=r):o==="style"?n[o]={...r,...s}:o==="className"&&(n[o]=[r,s].filter(Boolean).join(" "))}return{...e,...n}}function cr(e){var o,r;let t=(o=Object.getOwnPropertyDescriptor(e.props,"ref"))==null?void 0:o.get,n=t&&"isReactWarning"in t&&t.isReactWarning;return n?e.ref:(t=(r=Object.getOwnPropertyDescriptor(e,"ref"))==null?void 0:r.get,n=t&&"isReactWarning"in t&&t.isReactWarning,n?e.props.ref:e.props.ref||e.ref)}function ar(e){return u.isValidElement(e)&&typeof e.type=="function"&&"__radixId"in e.type&&e.type.__radixId===At}var lr=Symbol.for("react.lazy");function dt(e){return e!=null&&typeof e=="object"&&"$$typeof"in e&&e.$$typeof===lr&&"_payload"in e&&dr(e._payload)}function dr(e){return typeof e=="object"&&e!==null&&"then"in e}var ur=e=>`${e} failed to slot onto its children. Expected a single React element child or \`Slottable\`.`,fr=e=>`${e} failed to slot onto its \`Slottable\`. Expected \`Slottable\` to receive a single React element child.`,ye=Ie[" use ".trim().toString()],hr=["a","button","div","form","h2","h3","img","input","label","li","nav","ol","p","select","span","svg","ul"],Q=hr.reduce((e,t)=>{const n=or(`Primitive.${t}`),o=u.forwardRef((r,s)=>{const{asChild:i,...c}=r,a=i?n:t;return typeof window<"u"&&(window[Symbol.for("radix-ui")]=!0),R.jsx(a,{...c,ref:s})});return o.displayName=`Primitive.${t}`,{...e,[t]:o}},{});function pr(e,t){e&&Ve.flushSync(()=>e.dispatchEvent(t))}function be(e){const t=u.useRef(e);return u.useEffect(()=>{t.current=e}),u.useMemo(()=>((...n)=>{var o;return(o=t.current)==null?void 0:o.call(t,...n)}),[])}var yr="DismissableLayer",Le="dismissableLayer.update",mr="dismissableLayer.pointerDownOutside",vr="dismissableLayer.focusOutside",ut,Rt=u.createContext({layers:new Set,layersWithOutsidePointerEventsDisabled:new Set,branches:new Set,dismissableSurfaces:new Set}),Et=u.forwardRef((e,t)=>{const{disableOutsidePointerEvents:n=!1,deferPointerDownOutside:o=!1,onEscapeKeyDown:r,onPointerDownOutside:s,onFocusOutside:i,onInteractOutside:c,onDismiss:a,...f}=e,l=u.useContext(Rt),[d,p]=u.useState(null),h=(d==null?void 0:d.ownerDocument)??(globalThis==null?void 0:globalThis.document),[,y]=u.useState({}),m=oe(t,p),g=Array.from(l.layers),[x]=[...l.layersWithOutsidePointerEventsDisabled].slice(-1),k=x?g.indexOf(x):-1,w=d?g.indexOf(d):-1,b=l.layersWithOutsidePointerEventsDisabled.size>0,C=w>=k,M=u.useRef(!1),_=kr(E=>{s==null||s(E),c==null||c(E),E.defaultPrevented||a==null||a()},{ownerDocument:h,deferPointerDownOutside:o,isDeferredPointerDownOutsideRef:M,dismissableSurfaces:l.dismissableSurfaces,shouldHandlePointerDownOutside:u.useCallback(E=>{if(!(E instanceof Node))return!1;const D=[...l.branches].some(O=>O.contains(E));return C&&!D},[l.branches,C])}),N=br(E=>{if(o&&M.current)return;const D=E.target;[...l.branches].some(T=>T.contains(D))||(i==null||i(E),c==null||c(E),E.defaultPrevented||a==null||a())},h),$=d?w===g.length-1:!1,P=be(E=>{E.key==="Escape"&&(r==null||r(E),!E.defaultPrevented&&a&&(E.preventDefault(),a()))});return u.useEffect(()=>{if($)return h.addEventListener("keydown",P,{capture:!0}),()=>h.removeEventListener("keydown",P,{capture:!0})},[h,$,P]),u.useEffect(()=>{if(d)return n&&(l.layersWithOutsidePointerEventsDisabled.size===0&&(ut=h.body.style.pointerEvents,h.body.style.pointerEvents="none"),l.layersWithOutsidePointerEventsDisabled.add(d)),l.layers.add(d),ft(),()=>{n&&(l.layersWithOutsidePointerEventsDisabled.delete(d),l.layersWithOutsidePointerEventsDisabled.size===0&&(h.body.style.pointerEvents=ut))}},[d,h,n,l]),u.useEffect(()=>()=>{d&&(l.layers.delete(d),l.layersWithOutsidePointerEventsDisabled.delete(d),ft())},[d,l]),u.useEffect(()=>{const E=()=>y({});return document.addEventListener(Le,E),()=>document.removeEventListener(Le,E)},[]),R.jsx(Q.div,{...f,ref:m,style:{pointerEvents:b?C?"auto":"none":void 0,...e.style},onFocusCapture:q(e.onFocusCapture,N.onFocusCapture),onBlurCapture:q(e.onBlurCapture,N.onBlurCapture),onPointerDownCapture:q(e.onPointerDownCapture,_.onPointerDownCapture)})});Et.displayName=yr;var gr="DismissableLayerBranch",xr=u.forwardRef((e,t)=>{const n=u.useContext(Rt),o=u.useRef(null),r=oe(t,o);return u.useEffect(()=>{const s=o.current;if(s)return n.branches.add(s),()=>{n.branches.delete(s)}},[n.branches]),R.jsx(Q.div,{...e,ref:r})});xr.displayName=gr;var wr=()=>!0;function kr(e,t){const{ownerDocument:n=globalThis==null?void 0:globalThis.document,deferPointerDownOutside:o=!1,isDeferredPointerDownOutsideRef:r,dismissableSurfaces:s,shouldHandlePointerDownOutside:i=wr}=t,c=be(e),a=u.useRef(!1),f=u.useRef(!1),l=u.useRef(new Map),d=u.useRef(()=>{});return u.useEffect(()=>{function p(){f.current=!1,r.current=!1,l.current.clear()}function h(){return Array.from(l.current.values()).some(Boolean)}function y(w){if(!f.current)return;const b=w.target;b instanceof Node&&[...s].some(M=>M.contains(b))||l.current.set(w.type,!0),w.type==="click"&&window.setTimeout(()=>{f.current&&d.current()},0)}function m(w){f.current&&l.current.set(w.type,!1)}const g=w=>{if(w.target&&!a.current){let b=function(){n.removeEventListener("click",d.current);const M=h();p(),M||Pt(mr,c,C,{discrete:!0})};if(!i(w.target)){n.removeEventListener("click",d.current),p(),a.current=!1;return}const C={originalEvent:w};f.current=!0,r.current=o&&w.button===0,l.current.clear(),!o||w.button!==0?b():(n.removeEventListener("click",d.current),d.current=b,n.addEventListener("click",d.current,{once:!0}))}else n.removeEventListener("click",d.current),p();a.current=!1},x=["pointerup","mousedown","mouseup","touchstart","touchend","click"];for(const w of x)n.addEventListener(w,y,!0),n.addEventListener(w,m);const k=window.setTimeout(()=>{n.addEventListener("pointerdown",g)},0);return()=>{window.clearTimeout(k),n.removeEventListener("pointerdown",g),n.removeEventListener("click",d.current);for(const w of x)n.removeEventListener(w,y,!0),n.removeEventListener(w,m)}},[n,c,o,r,s,i]),{onPointerDownCapture:()=>a.current=!0}}function br(e,t=globalThis==null?void 0:globalThis.document){const n=be(e),o=u.useRef(!1);return u.useEffect(()=>{const r=s=>{s.target&&!o.current&&Pt(vr,n,{originalEvent:s},{discrete:!1})};return t.addEventListener("focusin",r),()=>t.removeEventListener("focusin",r)},[t,n]),{onFocusCapture:()=>o.current=!0,onBlurCapture:()=>o.current=!1}}function ft(){const e=new CustomEvent(Le);document.dispatchEvent(e)}function Pt(e,t,n,{discrete:o}){const r=n.originalEvent.target,s=new CustomEvent(e,{bubbles:!1,cancelable:!0,detail:n});t&&r.addEventListener(e,t,{once:!0}),o?pr(r,s):r.dispatchEvent(s)}var B=globalThis!=null&&globalThis.document?u.useLayoutEffect:()=>{},Mr=Ie[" useId ".trim().toString()]||(()=>{}),Cr=0;function _r(e){const[t,n]=u.useState(Mr());return B(()=>{n(o=>o??String(Cr++))},[e]),t?`radix-${t}`:""}const Ar=["top","right","bottom","left"],G=Math.min,U=Math.max,ge=Math.round,me=Math.floor,Y=e=>({x:e,y:e}),Rr={left:"right",right:"left",bottom:"top",top:"bottom"};function Nt(e,t,n){return U(e,G(t,n))}function X(e,t){return typeof e=="function"?e(t):e}function K(e){return e.split("-")[0]}function ie(e){return e.split("-")[1]}function We(e){return e==="x"?"y":"x"}function Fe(e){return e==="y"?"height":"width"}function V(e){const t=e[0];return t==="t"||t==="b"?"y":"x"}function qe(e){return We(V(e))}function Er(e,t,n){n===void 0&&(n=!1);const o=ie(e),r=qe(e),s=Fe(r);let i=r==="x"?o===(n?"end":"start")?"right":"left":o==="start"?"bottom":"top";return t.reference[s]>t.floating[s]&&(i=xe(i)),[i,xe(i)]}function Pr(e){const t=xe(e);return[De(e),t,De(t)]}function De(e){return e.includes("start")?e.replace("start","end"):e.replace("end","start")}const ht=["left","right"],pt=["right","left"],Nr=["top","bottom"],Or=["bottom","top"];function Sr(e,t,n){switch(e){case"top":case"bottom":return n?t?pt:ht:t?ht:pt;case"left":case"right":return t?Nr:Or;default:return[]}}function Tr(e,t,n,o){const r=ie(e);let s=Sr(K(e),n==="start",o);return r&&(s=s.map(i=>i+"-"+r),t&&(s=s.concat(s.map(De)))),s}function xe(e){const t=K(e);return Rr[t]+e.slice(t.length)}function $r(e){var t,n,o,r;return{top:(t=e.top)!=null?t:0,right:(n=e.right)!=null?n:0,bottom:(o=e.bottom)!=null?o:0,left:(r=e.left)!=null?r:0}}function Ot(e){return typeof e!="number"?$r(e):{top:e,right:e,bottom:e,left:e}}function we(e){const{x:t,y:n,width:o,height:r}=e;return{width:o,height:r,top:n,left:t,right:t+o,bottom:n+r,x:t,y:n}}function yt(e,t,n){let{reference:o,floating:r}=e;const s=V(t),i=qe(t),c=Fe(i),a=K(t),f=s==="y",l=o.x+o.width/2-r.width/2,d=o.y+o.height/2-r.height/2,p=o[c]/2-r[c]/2;let h;switch(a){case"top":h={x:l,y:o.y-r.height};break;case"bottom":h={x:l,y:o.y+o.height};break;case"right":h={x:o.x+o.width,y:d};break;case"left":h={x:o.x-r.width,y:d};break;default:h={x:o.x,y:o.y}}const y=ie(t);return y&&(h[i]+=p*(y==="end"?1:-1)*(n&&f?-1:1)),h}async function Lr(e,t){var n;t===void 0&&(t={});const{x:o,y:r,platform:s,rects:i,elements:c,strategy:a}=e,{boundary:f="clippingAncestors",rootBoundary:l="viewport",elementContext:d="floating",altBoundary:p=!1,padding:h=0}=X(t,e),y=Ot(h),g=c[p?d==="floating"?"reference":"floating":d],x=we(await s.getClippingRect({element:(n=await(s.isElement==null?void 0:s.isElement(g)))==null||n?g:g.contextElement||await(s.getDocumentElement==null?void 0:s.getDocumentElement(c.floating)),boundary:f,rootBoundary:l,strategy:a})),k=d==="floating"?{x:o,y:r,width:i.floating.width,height:i.floating.height}:i.reference,w=await(s.getOffsetParent==null?void 0:s.getOffsetParent(c.floating)),b=await(s.isElement==null?void 0:s.isElement(w))&&await(s.getScale==null?void 0:s.getScale(w))||{x:1,y:1},C=we(s.convertOffsetParentRelativeRectToViewportRelativeRect?await s.convertOffsetParentRelativeRectToViewportRelativeRect({elements:c,rect:k,offsetParent:w,strategy:a}):k);return{top:(x.top-C.top+y.top)/b.y,bottom:(C.bottom-x.bottom+y.bottom)/b.y,left:(x.left-C.left+y.left)/b.x,right:(C.right-x.right+y.right)/b.x}}const Dr=50,jr=async(e,t,n)=>{const{placement:o="bottom",strategy:r="absolute",middleware:s=[],platform:i}=n,c=i.detectOverflow?i:{...i,detectOverflow:Lr},a=await(i.isRTL==null?void 0:i.isRTL(t));let f=await i.getElementRects({reference:e,floating:t,strategy:r}),{x:l,y:d}=yt(f,o,a),p=o,h=0;const y={};for(let m=0;m<s.length;m++){const g=s[m];if(!g)continue;const{name:x,fn:k}=g,{x:w,y:b,data:C,reset:M}=await k({x:l,y:d,initialPlacement:o,placement:p,strategy:r,middlewareData:y,rects:f,platform:c,elements:{reference:e,floating:t}});l=w??l,d=b??d,y[x]={...y[x],...C},M&&h<Dr&&(h++,typeof M=="object"&&(M.placement&&(p=M.placement),M.rects&&(f=M.rects===!0?await i.getElementRects({reference:e,floating:t,strategy:r}):M.rects),{x:l,y:d}=yt(f,p,a)),m=-1)}return{x:l,y:d,placement:p,strategy:r,middlewareData:y}},zr=e=>({name:"arrow",options:e,async fn(t){const{x:n,y:o,placement:r,rects:s,platform:i,elements:c,middlewareData:a}=t,{element:f,padding:l=0}=X(e,t)||{};if(f==null)return{};const d=Ot(l),p={x:n,y:o},h=qe(r),y=Fe(h),m=await i.getDimensions(f),g=h==="y",x=g?"top":"left",k=g?"bottom":"right",w=g?"clientHeight":"clientWidth",b=s.reference[y]+s.reference[h]-p[h]-s.floating[y],C=p[h]-s.reference[h],M=await(i.getOffsetParent==null?void 0:i.getOffsetParent(f));let _=M?M[w]:0;(!_||!await(i.isElement==null?void 0:i.isElement(M)))&&(_=c.floating[w]||s.floating[y]);const N=b/2-C/2,$=_/2-m[y]/2-1,P=G(d[x],$),E=G(d[k],$),D=_-m[y]-E,O=_/2-m[y]/2+N,T=Nt(P,O,D),H=!a.arrow&&ie(r)!=null&&O!==T&&s.reference[y]/2-(O<P?P:E)-m[y]/2<0,S=H?O<P?O-P:O-D:0;return{[h]:p[h]+S,data:{[h]:T,centerOffset:O-T-S,...H&&{alignmentOffset:S}},reset:H}}}),Hr=function(e){return e===void 0&&(e={}),{name:"flip",options:e,async fn(t){var n,o;const{placement:r,middlewareData:s,rects:i,initialPlacement:c,platform:a,elements:f}=t,{mainAxis:l=!0,crossAxis:d=!0,fallbackPlacements:p,fallbackStrategy:h="bestFit",fallbackAxisSideDirection:y="none",flipAlignment:m=!0,...g}=X(e,t);if((n=s.arrow)!=null&&n.alignmentOffset)return{};const x=K(r),k=V(c),w=K(c)===c,b=await(a.isRTL==null?void 0:a.isRTL(f.floating)),C=p||(w||!m?[xe(c)]:Pr(c)),M=y!=="none";!p&&M&&C.push(...Tr(c,m,y,b));const _=[c,...C],N=await a.detectOverflow(t,g),$=[];let P=((o=s.flip)==null?void 0:o.overflows)||[];if(l&&$.push(N[x]),d){const T=Er(r,i,b);$.push(N[T[0]],N[T[1]])}if(P=[...P,{placement:r,overflows:$}],!$.every(T=>T<=0)){var E,D;const T=(((E=s.flip)==null?void 0:E.index)||0)+1,H=_[T];if(H&&(!(d==="alignment"?k!==V(H):!1)||P.every(A=>V(A.placement)===k?A.overflows[0]>0:!0)))return{data:{index:T,overflows:P},reset:{placement:H}};let S=(D=P.filter(j=>j.overflows[0]<=0).sort((j,A)=>j.overflows[1]-A.overflows[1])[0])==null?void 0:D.placement;if(!S)switch(h){case"bestFit":{var O;const j=(O=P.filter(A=>{if(M){const L=V(A.placement);return L===k||L==="y"}return!0}).map(A=>[A.placement,A.overflows.filter(L=>L>0).reduce((L,I)=>L+I,0)]).sort((A,L)=>A[1]-L[1])[0])==null?void 0:O[0];j&&(S=j);break}case"initialPlacement":S=c;break}if(r!==S)return{reset:{placement:S}}}return{}}}};function mt(e,t){return{top:e.top-t.height,right:e.right-t.width,bottom:e.bottom-t.height,left:e.left-t.width}}function vt(e){return Ar.some(t=>e[t]>=0)}const Ir=function(e){return e===void 0&&(e={}),{name:"hide",options:e,async fn(t){const{rects:n,platform:o}=t,{strategy:r="referenceHidden",...s}=X(e,t);switch(r){case"referenceHidden":{const i=await o.detectOverflow(t,{...s,elementContext:"reference"}),c=mt(i,n.reference);return{data:{referenceHiddenOffsets:c,referenceHidden:vt(c)}}}case"escaped":{const i=await o.detectOverflow(t,{...s,altBoundary:!0}),c=mt(i,n.floating);return{data:{escapedOffsets:c,escaped:vt(c)}}}default:return{}}}}},St=new Set(["left","top"]);async function Vr(e,t){const{placement:n,platform:o,elements:r}=e,s=await(o.isRTL==null?void 0:o.isRTL(r.floating)),i=K(n),c=ie(n),a=V(n)==="y",f=St.has(i)?-1:1,l=s&&a?-1:1,d=X(t,e);let{mainAxis:p,crossAxis:h,alignmentAxis:y}=typeof d=="number"?{mainAxis:d,crossAxis:0,alignmentAxis:null}:{mainAxis:d.mainAxis||0,crossAxis:d.crossAxis||0,alignmentAxis:d.alignmentAxis};return c&&typeof y=="number"&&(h=c==="end"?y*-1:y),a?{x:h*l,y:p*f}:{x:p*f,y:h*l}}const Wr=function(e){return e===void 0&&(e=0),{name:"offset",options:e,async fn(t){var n,o;const{x:r,y:s,placement:i,middlewareData:c}=t,a=await Vr(t,e);return i===((n=c.offset)==null?void 0:n.placement)&&(o=c.arrow)!=null&&o.alignmentOffset?{}:{x:r+a.x,y:s+a.y,data:{...a,placement:i}}}}},Fr=function(e){return e===void 0&&(e={}),{name:"shift",options:e,async fn(t){const{x:n,y:o,placement:r,platform:s}=t,{mainAxis:i=!0,crossAxis:c=!1,limiter:a={fn:k=>{let{x:w,y:b}=k;return{x:w,y:b}}},...f}=X(e,t),l={x:n,y:o},d=await s.detectOverflow(t,f),p=V(r),h=We(p);let y=l[h],m=l[p];const g=(k,w)=>Nt(w+d[k==="y"?"top":"left"],w,w-d[k==="y"?"bottom":"right"]);i&&(y=g(h,y)),c&&(m=g(p,m));const x=a.fn({...t,[h]:y,[p]:m});return{...x,data:{x:x.x-n,y:x.y-o,enabled:{[h]:i,[p]:c}}}}}},qr=function(e){return e===void 0&&(e={}),{options:e,fn(t){var n,o;const{x:r,y:s,placement:i,rects:c,middlewareData:a}=t,{offset:f=0,mainAxis:l=!0,crossAxis:d=!0}=X(e,t),p={x:r,y:s},h=V(i),y=We(h);let m=p[y],g=p[h];const x=X(f,t),k=typeof x=="number"?{mainAxis:x,crossAxis:0}:{mainAxis:(n=x.mainAxis)!=null?n:0,crossAxis:(o=x.crossAxis)!=null?o:0};if(l){const C=y==="y"?"height":"width",M=c.reference[y]-c.floating[C]+k.mainAxis,_=c.reference[y]+c.reference[C]-k.mainAxis;m<M?m=M:m>_&&(m=_)}if(d){var w,b;const C=y==="y"?"width":"height",M=St.has(K(i)),_=c.reference[h]-c.floating[C]+(M&&((w=a.offset)==null?void 0:w[h])||0)+(M?0:k.crossAxis),N=c.reference[h]+c.reference[C]+(M?0:((b=a.offset)==null?void 0:b[h])||0)-(M?k.crossAxis:0);g<_?g=_:g>N&&(g=N)}return{[y]:m,[h]:g}}}},Br=function(e){return e===void 0&&(e={}),{name:"size",options:e,async fn(t){const{placement:n,rects:o,platform:r,elements:s}=t,{apply:i=()=>{},...c}=X(e,t),a=await r.detectOverflow(t,c),f=K(n),l=ie(n),d=V(n)==="y",{width:p,height:h}=o.floating;let y,m;f==="top"||f==="bottom"?(y=f,m=l===(await(r.isRTL==null?void 0:r.isRTL(s.floating))?"start":"end")?"left":"right"):(m=f,y=l==="end"?"top":"bottom");const g=h-a.top-a.bottom,x=p-a.left-a.right,k=G(h-a[y],g),w=G(p-a[m],x),b=t.middlewareData.shift,C=!b;let M=k,_=w;b!=null&&b.enabled.x&&(_=x),b!=null&&b.enabled.y&&(M=g),C&&!l&&(d?_=p-2*U(a.left,a.right):M=h-2*U(a.top,a.bottom)),await i({...t,availableWidth:_,availableHeight:M});const N=await r.getDimensions(s.floating);return p!==N.width||h!==N.height?{reset:{rects:!0}}:{}}}};function Me(){return typeof window<"u"}function ce(e){return Tt(e)?(e.nodeName||"").toLowerCase():"#document"}function z(e){var t;return(e==null||(t=e.ownerDocument)==null?void 0:t.defaultView)||window}function Z(e){var t;return(t=(Tt(e)?e.ownerDocument:e.document)||window.document)==null?void 0:t.documentElement}function Tt(e){return Me()?e instanceof Node||e instanceof z(e).Node:!1}function W(e){return Me()?e instanceof Element||e instanceof z(e).Element:!1}function J(e){return Me()?e instanceof HTMLElement||e instanceof z(e).HTMLElement:!1}function gt(e){return!Me()||typeof ShadowRoot>"u"?!1:e instanceof ShadowRoot||e instanceof z(e).ShadowRoot}function Ce(e){const{overflow:t,overflowX:n,overflowY:o,display:r}=F(e);return/auto|scroll|overlay|hidden|clip/.test(t+o+n)&&r!=="inline"&&r!=="contents"}function Ur(e){return/^(table|td|th)$/.test(ce(e))}function _e(e){try{if(e.matches(":popover-open"))return!0}catch{}try{return e.matches(":modal")}catch{return!1}}const Yr=/transform|translate|scale|rotate|perspective|filter/,Xr=/paint|layout|strict|content/,ee=e=>!!e&&e!=="none";let Se;function Be(e){const t=W(e)?F(e):e;return ee(t.transform)||ee(t.translate)||ee(t.scale)||ee(t.rotate)||ee(t.perspective)||!Ue()&&(ee(t.backdropFilter)||ee(t.filter))||Yr.test(t.willChange||"")||Xr.test(t.contain||"")}function Zr(e){let t=te(e);for(;J(t)&&!le(t);){if(Be(t))return t;if(_e(t))return null;t=te(t)}return null}function Ue(){return Se==null&&(Se=typeof CSS<"u"&&CSS.supports&&CSS.supports("-webkit-backdrop-filter","none")),Se}function le(e){return/^(html|body|#document)$/.test(ce(e))}function F(e){return z(e).getComputedStyle(e)}function Ae(e){return W(e)?{scrollLeft:e.scrollLeft,scrollTop:e.scrollTop}:{scrollLeft:e.scrollX,scrollTop:e.scrollY}}function te(e){if(ce(e)==="html")return e;const t=e.assignedSlot||e.parentNode||gt(e)&&e.host||Z(e);return gt(t)?t.host:t}function $t(e){const t=te(e);return le(t)?(e.ownerDocument||e).body:J(t)&&Ce(t)?t:$t(t)}function de(e,t,n){var o;t===void 0&&(t=[]),n===void 0&&(n=!0);const r=$t(e),s=r===((o=e.ownerDocument)==null?void 0:o.body),i=z(r);if(s){const c=je(i);return t.concat(i,i.visualViewport||[],Ce(r)?r:[],c&&n?de(c):[])}else return t.concat(r,de(r,[],n))}function je(e){return e.parent&&Object.getPrototypeOf(e.parent)?e.frameElement:null}function Lt(e){const t=F(e);let n=parseFloat(t.width)||0,o=parseFloat(t.height)||0;const r=J(e),s=r?e.offsetWidth:n,i=r?e.offsetHeight:o,c=ge(n)!==s||ge(o)!==i;return c&&(n=s,o=i),{width:n,height:o,$:c}}function Ye(e){return W(e)?e:e.contextElement}function re(e){const t=Ye(e);if(!J(t))return Y(1);const n=t.getBoundingClientRect(),{width:o,height:r,$:s}=Lt(t);let i=(s?ge(n.width):n.width)/o,c=(s?ge(n.height):n.height)/r;return(!i||!Number.isFinite(i))&&(i=1),(!c||!Number.isFinite(c))&&(c=1),{x:i,y:c}}const Gr=Y(0);function Dt(e){const t=z(e);return!Ue()||!t.visualViewport?Gr:{x:t.visualViewport.offsetLeft,y:t.visualViewport.offsetTop}}function Kr(e,t,n){return t===void 0&&(t=!1),!!n&&t&&n===z(e)}function ne(e,t,n,o){t===void 0&&(t=!1),n===void 0&&(n=!1);const r=e.getBoundingClientRect(),s=Ye(e);let i=Y(1);t&&(o?W(o)&&(i=re(o)):i=re(e));const c=Kr(s,n,o)?Dt(s):Y(0);let a=(r.left+c.x)/i.x,f=(r.top+c.y)/i.y,l=r.width/i.x,d=r.height/i.y;if(s&&o){const p=z(s),h=W(o)?z(o):o;let y=p,m=je(y);for(;m&&h!==y;){const g=re(m),x=m.getBoundingClientRect(),k=F(m),w=x.left+(m.clientLeft+parseFloat(k.paddingLeft))*g.x,b=x.top+(m.clientTop+parseFloat(k.paddingTop))*g.y;a*=g.x,f*=g.y,l*=g.x,d*=g.y,a+=w,f+=b,y=z(m),m=je(y)}}return we({width:l,height:d,x:a,y:f})}function Re(e,t){const n=Ae(e).scrollLeft;return t?t.left+n:ne(Z(e)).left+n}function jt(e,t){const n=e.getBoundingClientRect(),o=n.left+t.scrollLeft-Re(e,n),r=n.top+t.scrollTop;return{x:o,y:r}}function Qr(e){let{elements:t,rect:n,offsetParent:o,strategy:r}=e;const s=r==="fixed",i=Z(o),c=t?_e(t.floating):!1;if(o===i||c&&s)return n;let a={scrollLeft:0,scrollTop:0},f=Y(1);const l=Y(0),d=J(o);if((d||!s)&&((ce(o)!=="body"||Ce(i))&&(a=Ae(o)),d)){const h=ne(o);f=re(o),l.x=h.x+o.clientLeft,l.y=h.y+o.clientTop}const p=i&&!d&&!s?jt(i,a):Y(0);return{width:n.width*f.x,height:n.height*f.y,x:n.x*f.x-a.scrollLeft*f.x+l.x+p.x,y:n.y*f.y-a.scrollTop*f.y+l.y+p.y}}function Jr(e){return e.getClientRects?Array.from(e.getClientRects()):[]}function es(e){const t=Ae(e),n=e.ownerDocument.body,o=U(e.scrollWidth,e.clientWidth,n.scrollWidth,n.clientWidth),r=U(e.scrollHeight,e.clientHeight,n.scrollHeight,n.clientHeight);let s=-t.scrollLeft+Re(e);const i=-t.scrollTop;return F(n).direction==="rtl"&&(s+=U(e.clientWidth,n.clientWidth)-o),{width:o,height:r,x:s,y:i}}const ts=25;function ns(e,t,n){n===void 0&&(n="viewport");const o=n==="layoutViewport",r=z(e),s=Z(e),i=r.visualViewport;let c=s.clientWidth,a=s.clientHeight,f=0,l=0;if(i){const p=!Ue()||t==="fixed";o?p||(f=-i.offsetLeft,l=-i.offsetTop):(c=i.width,a=i.height,p&&(f=i.offsetLeft,l=i.offsetTop))}if(Re(s)<=0){const p=s.ownerDocument,h=p.body,y=getComputedStyle(h),m=p.compatMode==="CSS1Compat"&&parseFloat(y.marginLeft)+parseFloat(y.marginRight)||0,g=Math.abs(s.clientWidth-h.clientWidth-m),x=getComputedStyle(s).scrollbarGutter==="stable both-edges"?g/2:g;x<=ts&&(c-=x)}return{width:c,height:a,x:f,y:l}}function os(e,t){const n=ne(e,!0,t==="fixed"),o=n.top+e.clientTop,r=n.left+e.clientLeft,s=re(e),i=e.clientWidth*s.x,c=e.clientHeight*s.y,a=r*s.x,f=o*s.y;return{width:i,height:c,x:a,y:f}}function xt(e,t,n){let o;if(t==="viewport"||t==="layoutViewport")o=ns(e,n,t);else if(t==="document")o=es(Z(e));else if(W(t))o=os(t,n);else{const r=Dt(e);o={x:t.x-r.x,y:t.y-r.y,width:t.width,height:t.height}}return we(o)}function rs(e,t){const n=t.get(e);if(n)return n;let o=de(e,[],!1).filter(c=>W(c)&&ce(c)!=="body"),r=null;const s=F(e).position==="fixed";let i=s?te(e):e;for(;W(i)&&!le(i);){const c=F(i),a=Be(i),f=r?r.position:s?"fixed":"";!a&&(f==="fixed"||f==="absolute"&&c.position==="static")?o=o.filter(d=>d!==i):r=c,i=te(i)}return t.set(e,o),o}function ss(e){let{element:t,boundary:n,rootBoundary:o,strategy:r}=e;const i=[...n==="clippingAncestors"?_e(t)?[]:rs(t,this._c):[].concat(n),o],c=xt(t,i[0],r);let a=c.top,f=c.right,l=c.bottom,d=c.left;for(let p=1;p<i.length;p++){const h=xt(t,i[p],r);a=U(h.top,a),f=G(h.right,f),l=G(h.bottom,l),d=U(h.left,d)}return{width:f-d,height:l-a,x:d,y:a}}function is(e){const{width:t,height:n}=Lt(e);return{width:t,height:n}}function cs(e,t,n){const o=J(t),r=Z(t),s=n==="fixed",i=ne(e,!0,s,t);let c={scrollLeft:0,scrollTop:0};const a=Y(0);if((o||!s)&&((ce(t)!=="body"||Ce(r))&&(c=Ae(t)),o)){const p=ne(t,!0,s,t);a.x=p.x+t.clientLeft,a.y=p.y+t.clientTop}!o&&r&&(a.x=Re(r));const f=r&&!o&&!s?jt(r,c):Y(0),l=i.left+c.scrollLeft-a.x-f.x,d=i.top+c.scrollTop-a.y-f.y;return{x:l,y:d,width:i.width,height:i.height}}function Te(e){return F(e).position==="static"}function wt(e,t){if(!J(e)||F(e).position==="fixed")return null;if(t)return t(e);let n=e.offsetParent;return Z(e)===n&&(n=n.ownerDocument.body),n}function zt(e,t){const n=z(e);if(_e(e))return n;if(!J(e)){let r=te(e);for(;r&&!le(r);){if(W(r)&&!Te(r))return r;r=te(r)}return n}let o=wt(e,t);for(;o&&Ur(o)&&Te(o);)o=wt(o,t);return o&&le(o)&&Te(o)&&!Be(o)?n:o||Zr(e)||n}const as=async function(e){const t=this.getOffsetParent||zt,n=this.getDimensions,o=await n(e.floating);return{reference:cs(e.reference,await t(e.floating),e.strategy),floating:{x:0,y:0,width:o.width,height:o.height}}};function ls(e){return F(e).direction==="rtl"}const ds={convertOffsetParentRelativeRectToViewportRelativeRect:Qr,getDocumentElement:Z,getClippingRect:ss,getOffsetParent:zt,getElementRects:as,getClientRects:Jr,getDimensions:is,getScale:re,isElement:W,isRTL:ls};function Ht(e,t){return e.x===t.x&&e.y===t.y&&e.width===t.width&&e.height===t.height}function us(e,t,n){let o=null,r;const s=Z(e);function i(){var l;clearTimeout(r),(l=o)==null||l.disconnect(),o=null}function c(l,d){l===void 0&&(l=!1),d===void 0&&(d=1),i();const p=e.getBoundingClientRect(),{left:h,top:y,width:m,height:g}=p;if(l||t(),!m||!g)return;const x=me(y),k=me(s.clientWidth-(h+m)),w=me(s.clientHeight-(y+g)),b=me(h),M={rootMargin:-x+"px "+-k+"px "+-w+"px "+-b+"px",threshold:U(0,G(1,d))||1};let _=!0;function N($){const P=$[0].intersectionRatio;if(!Ht(p,e.getBoundingClientRect()))return c();if(P!==d){if(!_)return c();P?c(!1,P):r=setTimeout(()=>{c(!1,1e-7)},1e3)}_=!1}try{o=new IntersectionObserver(N,{...M,root:s.ownerDocument})}catch{o=new IntersectionObserver(N,M)}o.observe(e)}const a=z(e),f=()=>c(n);return a.addEventListener("resize",f),c(!0),()=>{a.removeEventListener("resize",f),i()}}function fs(e,t,n,o){o===void 0&&(o={});const{ancestorScroll:r=!0,ancestorResize:s=!0,elementResize:i=typeof ResizeObserver=="function",layoutShift:c=typeof IntersectionObserver=="function",animationFrame:a=!1}=o,f=Ye(e),l=r||s?[...f?de(f):[],...t?de(t):[]]:[];l.forEach(x=>{r&&x.addEventListener("scroll",n),s&&x.addEventListener("resize",n)});const d=f&&c?us(f,n,s):null;let p=-1,h=null;i&&(h=new ResizeObserver(x=>{let[k]=x;k&&k.target===f&&h&&t&&(h.unobserve(t),cancelAnimationFrame(p),p=requestAnimationFrame(()=>{var w;(w=h)==null||w.observe(t)})),n()}),f&&!a&&h.observe(f),t&&h.observe(t));let y,m=a?ne(e):null;a&&g();function g(){const x=ne(e);m&&!Ht(m,x)&&n(),m=x,y=requestAnimationFrame(g)}return n(),()=>{var x;l.forEach(k=>{r&&k.removeEventListener("scroll",n),s&&k.removeEventListener("resize",n)}),d==null||d(),(x=h)==null||x.disconnect(),h=null,a&&cancelAnimationFrame(y)}}const hs=Wr,ps=Fr,ys=Hr,ms=Br,vs=Ir,kt=zr,gs=qr,xs=(e,t,n)=>{const o=new Map,r=n??{},s={...ds,...r.platform,_c:o};return jr(e,t,{...r,platform:s})};var ws=typeof document<"u",ks=function(){},ve=ws?u.useLayoutEffect:ks;function ke(e,t){if(e===t)return!0;if(typeof e!=typeof t)return!1;if(typeof e=="function"&&e.toString()===t.toString())return!0;let n,o,r;if(e&&t&&typeof e=="object"){if(Array.isArray(e)){if(n=e.length,n!==t.length)return!1;for(o=n;o--!==0;)if(!ke(e[o],t[o]))return!1;return!0}if(r=Object.keys(e),n=r.length,n!==Object.keys(t).length)return!1;for(o=n;o--!==0;)if(!{}.hasOwnProperty.call(t,r[o]))return!1;for(o=n;o--!==0;){const s=r[o];if(!(s==="_owner"&&e.$$typeof)&&!ke(e[s],t[s]))return!1}return!0}return e!==e&&t!==t}function It(e){return typeof window>"u"?1:(e.ownerDocument.defaultView||window).devicePixelRatio||1}function bt(e,t){const n=It(e);return Math.round(t*n)/n}function $e(e){const t=u.useRef(e);return ve(()=>{t.current=e}),t}function bs(e){e===void 0&&(e={});const{placement:t="bottom",strategy:n="absolute",middleware:o=[],platform:r,elements:{reference:s,floating:i}={},transform:c=!0,whileElementsMounted:a,open:f}=e,[l,d]=u.useState({x:0,y:0,strategy:n,placement:t,middlewareData:{},isPositioned:!1}),[p,h]=u.useState(o);ke(p,o)||h(o);const[y,m]=u.useState(null),[g,x]=u.useState(null),k=u.useCallback(A=>{A!==M.current&&(M.current=A,m(A))},[]),w=u.useCallback(A=>{A!==_.current&&(_.current=A,x(A))},[]),b=s||y,C=i||g,M=u.useRef(null),_=u.useRef(null),N=u.useRef(l),$=a!=null,P=$e(a),E=$e(r),D=$e(f),O=u.useCallback(()=>{if(!M.current||!_.current)return;const A={placement:t,strategy:n,middleware:p};E.current&&(A.platform=E.current),xs(M.current,_.current,A).then(L=>{const I={...L,isPositioned:D.current!==!1};T.current&&!ke(N.current,I)&&(N.current=I,Ve.flushSync(()=>{d(I)}))})},[p,t,n,E,D]);ve(()=>{f===!1&&N.current.isPositioned&&(N.current.isPositioned=!1,d(A=>({...A,isPositioned:!1})))},[f]);const T=u.useRef(!1);ve(()=>(T.current=!0,()=>{T.current=!1}),[]),ve(()=>{if(b&&(M.current=b),C&&(_.current=C),b&&C){if(P.current)return P.current(b,C,O);O()}},[b,C,O,P,$]);const H=u.useMemo(()=>({reference:M,floating:_,setReference:k,setFloating:w}),[k,w]),S=u.useMemo(()=>({reference:b,floating:C}),[b,C]),j=u.useMemo(()=>{const A={position:n,left:0,top:0};if(!S.floating)return A;const L=bt(S.floating,l.x),I=bt(S.floating,l.y);return c?{...A,transform:"translate("+L+"px, "+I+"px)",...It(S.floating)>=1.5&&{willChange:"transform"}}:{position:n,left:L,top:I}},[n,c,S.floating,l.x,l.y]);return u.useMemo(()=>({...l,update:O,refs:H,elements:S,floatingStyles:j}),[l,O,H,S,j])}const Ms=e=>{function t(n){return{}.hasOwnProperty.call(n,"current")}return{name:"arrow",options:e,fn(n){const{element:o,padding:r}=typeof e=="function"?e(n):e;return o&&t(o)?o.current!=null?kt({element:o.current,padding:r}).fn(n):{}:o?kt({element:o,padding:r}).fn(n):{}}}},Cs=(e,t)=>{const n=hs(e);return{name:n.name,fn:n.fn,options:[e,t]}},_s=(e,t)=>{const n=ps(e);return{name:n.name,fn:n.fn,options:[e,t]}},As=(e,t)=>({fn:gs(e).fn,options:[e,t]}),Rs=(e,t)=>{const n=ys(e);return{name:n.name,fn:n.fn,options:[e,t]}},Es=(e,t)=>{const n=ms(e);return{name:n.name,fn:n.fn,options:[e,t]}},Ps=(e,t)=>{const n=vs(e);return{name:n.name,fn:n.fn,options:[e,t]}},Ns=(e,t)=>{const n=Ms(e);return{name:n.name,fn:n.fn,options:[e,t]}};var Os="Arrow",Vt=u.forwardRef((e,t)=>{const{children:n,width:o=10,height:r=5,...s}=e;return R.jsx(Q.svg,{...s,ref:t,width:o,height:r,viewBox:"0 0 30 10",preserveAspectRatio:"none",children:e.asChild?n:R.jsx("polygon",{points:"0,0 30,0 15,10"})})});Vt.displayName=Os;var Ss=Vt;function Ts(e){const[t,n]=u.useState(void 0);return B(()=>{if(e){n({width:e.offsetWidth,height:e.offsetHeight});const o=new ResizeObserver(r=>{if(!Array.isArray(r)||!r.length)return;const s=r[0];let i,c;if("borderBoxSize"in s){const a=s.borderBoxSize,f=Array.isArray(a)?a[0]:a;i=f.inlineSize,c=f.blockSize}else i=e.offsetWidth,c=e.offsetHeight;n({width:i,height:c})});return o.observe(e,{box:"border-box"}),()=>o.unobserve(e)}else n(void 0)},[e]),t}var Xe="Popper",[Wt,Ft]=_t(Xe),[$s,qt]=Wt(Xe),Bt=e=>{const{__scopePopper:t,children:n}=e,[o,r]=u.useState(null),[s,i]=u.useState(void 0);return R.jsx($s,{scope:t,anchor:o,onAnchorChange:r,placementState:s,setPlacementState:i,children:n})};Bt.displayName=Xe;var Ut="PopperAnchor",Yt=u.forwardRef((e,t)=>{const{__scopePopper:n,virtualRef:o,...r}=e,s=qt(Ut,n),i=u.useRef(null),c=s.onAnchorChange,a=u.useCallback(y=>{i.current=y,y&&c(y)},[c]),f=oe(t,a),l=u.useRef(null);u.useEffect(()=>{if(!o)return;const y=l.current;l.current=o.current,y!==l.current&&c(l.current)});const d=s.placementState&&Ge(s.placementState),p=d==null?void 0:d[0],h=d==null?void 0:d[1];return o?null:R.jsx(Q.div,{"data-radix-popper-side":p,"data-radix-popper-align":h,...r,ref:f})});Yt.displayName=Ut;var Ze="PopperContent",[Ls,Ds]=Wt(Ze),Xt=u.forwardRef((e,t)=>{var tt,nt,ot,rt,st,it;const{__scopePopper:n,side:o="bottom",sideOffset:r=0,align:s="center",alignOffset:i=0,arrowPadding:c=0,avoidCollisions:a=!0,collisionBoundary:f=[],collisionPadding:l=0,sticky:d="partial",hideWhenDetached:p=!1,updatePositionStrategy:h="optimized",onPlaced:y,...m}=e,g=qt(Ze,n),[x,k]=u.useState(null),w=oe(t,k),[b,C]=u.useState(null),M=Ts(b),_=(M==null?void 0:M.width)??0,N=(M==null?void 0:M.height)??0,$=o+(s!=="center"?"-"+s:""),P=typeof l=="number"?l:{top:0,right:0,bottom:0,left:0,...l},E=Array.isArray(f)?f:[f],D=E.length>0,O={padding:P,boundary:E.filter(zs),altBoundary:D},{refs:T,floatingStyles:H,placement:S,isPositioned:j,middlewareData:A}=bs({strategy:"fixed",placement:$,whileElementsMounted:(...Ne)=>fs(...Ne,{animationFrame:h==="always"}),elements:{reference:g.anchor},middleware:[Cs({mainAxis:r+N,alignmentAxis:i}),a&&_s({mainAxis:!0,crossAxis:!1,limiter:d==="partial"?As():void 0,...O}),a&&Rs({...O}),Es({...O,apply:({elements:Ne,rects:ct,availableWidth:pn,availableHeight:yn})=>{const{width:mn,height:vn}=ct.reference,pe=Ne.floating.style;pe.setProperty("--radix-popper-available-width",`${pn}px`),pe.setProperty("--radix-popper-available-height",`${yn}px`),pe.setProperty("--radix-popper-anchor-width",`${mn}px`),pe.setProperty("--radix-popper-anchor-height",`${vn}px`)}}),b&&Ns({element:b,padding:c}),Hs({arrowWidth:_,arrowHeight:N}),p&&Ps({strategy:"referenceHidden",...O,boundary:D?O.boundary:void 0})]}),L=g.setPlacementState;B(()=>(L(S),()=>{L(void 0)}),[S,L]);const[I,et]=Ge(S),he=be(y);B(()=>{j&&(he==null||he())},[j,he]);const ln=(tt=A.arrow)==null?void 0:tt.x,dn=(nt=A.arrow)==null?void 0:nt.y,un=((ot=A.arrow)==null?void 0:ot.centerOffset)!==0,[fn,hn]=u.useState();return B(()=>{x&&hn(window.getComputedStyle(x).zIndex)},[x]),R.jsx("div",{ref:T.setFloating,"data-radix-popper-content-wrapper":"",style:{...H,transform:j?H.transform:"translate(0, -200%)",minWidth:"max-content",zIndex:fn,"--radix-popper-transform-origin":[(rt=A.transformOrigin)==null?void 0:rt.x,(st=A.transformOrigin)==null?void 0:st.y].join(" "),...((it=A.hide)==null?void 0:it.referenceHidden)&&{visibility:"hidden",pointerEvents:"none"}},dir:e.dir,children:R.jsx(Ls,{scope:n,placedSide:I,placedAlign:et,onArrowChange:C,arrowX:ln,arrowY:dn,shouldHideArrow:un,children:R.jsx(Q.div,{"data-side":I,"data-align":et,...m,ref:w,style:{...m.style,animation:j?void 0:"none"}})})})});Xt.displayName=Ze;var Zt="PopperArrow",js={top:"bottom",right:"left",bottom:"top",left:"right"},Gt=u.forwardRef(function(t,n){const{__scopePopper:o,...r}=t,s=Ds(Zt,o),i=js[s.placedSide];return R.jsx("span",{ref:s.onArrowChange,style:{position:"absolute",left:s.arrowX,top:s.arrowY,[i]:0,transformOrigin:{top:"",right:"0 0",bottom:"center 0",left:"100% 0"}[s.placedSide],transform:{top:"translateY(100%)",right:"translateY(50%) rotate(90deg) translateX(-50%)",bottom:"rotate(180deg)",left:"translateY(50%) rotate(-90deg) translateX(50%)"}[s.placedSide],visibility:s.shouldHideArrow?"hidden":void 0},children:R.jsx(Ss,{...r,ref:n,style:{...r.style,display:"block"}})})});Gt.displayName=Zt;function zs(e){return e!==null}var Hs=e=>({name:"transformOrigin",options:e,fn(t){var g,x,k;const{placement:n,rects:o,middlewareData:r}=t,i=((g=r.arrow)==null?void 0:g.centerOffset)!==0,c=i?0:e.arrowWidth,a=i?0:e.arrowHeight,[f,l]=Ge(n),d={start:"0%",center:"50%",end:"100%"}[l],p=(((x=r.arrow)==null?void 0:x.x)??0)+c/2,h=(((k=r.arrow)==null?void 0:k.y)??0)+a/2;let y="",m="";return f==="bottom"?(y=i?d:`${p}px`,m=`${-a}px`):f==="top"?(y=i?d:`${p}px`,m=`${o.floating.height+a}px`):f==="right"?(y=`${-a}px`,m=i?d:`${h}px`):f==="left"&&(y=`${o.floating.width+a}px`,m=i?d:`${h}px`),{data:{x:y,y:m}}}});function Ge(e){const[t,n="center"]=e.split("-");return[t,n]}var Is=Bt,Vs=Yt,Ws=Xt,Fs=Gt,qs="Portal",Kt=u.forwardRef((e,t)=>{var c;const{container:n,...o}=e,[r,s]=u.useState(!1);B(()=>s(!0),[]);const i=n||r&&((c=globalThis==null?void 0:globalThis.document)==null?void 0:c.body);return i?Ve.createPortal(R.jsx(Q.div,{...o,ref:t}),i):null});Kt.displayName=qs;function Bs(e,t){return u.useReducer((n,o)=>t[n][o]??n,e)}var Ke=e=>{const{present:t,children:n}=e,o=Us(t),r=typeof n=="function"?n({present:o.isPresent}):u.Children.only(n),s=Ys(o.ref,Xs(r));return typeof n=="function"||o.isPresent?u.cloneElement(r,{ref:s}):null};Ke.displayName="Presence";function Us(e){const[t,n]=u.useState(),o=u.useRef(null),r=u.useRef(e),s=u.useRef("none"),i=u.useRef(void 0),c=e?"mounted":"unmounted",[a,f]=Bs(c,{mounted:{UNMOUNT:"unmounted",ANIMATION_OUT:"unmountSuspended"},unmountSuspended:{MOUNT:"mounted",ANIMATION_END:"unmounted"},unmounted:{MOUNT:"mounted"}});return u.useEffect(()=>{a==="mounted"?(s.current=i.current??ae(o.current),i.current=void 0):s.current="none"},[a]),B(()=>{const l=o.current,d=r.current;if(d!==e){const h=s.current,y=ae(l);e?(i.current=y,f("MOUNT")):y==="none"||(l==null?void 0:l.display)==="none"?f("UNMOUNT"):f(d&&h!==y?"ANIMATION_OUT":"UNMOUNT"),r.current=e}},[e,f]),B(()=>{if(t){let l;const d=t.ownerDocument.defaultView??window,p=y=>{const g=ae(o.current).includes(CSS.escape(y.animationName));if(y.target===t&&g&&(f("ANIMATION_END"),!r.current)){const x=t.style.animationFillMode;t.style.animationFillMode="forwards",l=d.setTimeout(()=>{t.style.animationFillMode==="forwards"&&(t.style.animationFillMode=x)})}},h=y=>{y.target===t&&(s.current=ae(o.current))};return t.addEventListener("animationstart",h),t.addEventListener("animationcancel",p),t.addEventListener("animationend",p),()=>{d.clearTimeout(l),t.removeEventListener("animationstart",h),t.removeEventListener("animationcancel",p),t.removeEventListener("animationend",p)}}else f("ANIMATION_END")},[t,f]),{isPresent:["mounted","unmountSuspended"].includes(a),ref:u.useCallback(l=>{if(l){const d=getComputedStyle(l);o.current=d,i.current=ae(d)}else o.current=null;n(l)},[])}}function Mt(e,t){if(typeof e=="function")return e(t);e!=null&&(e.current=t)}function Ys(...e){const t=u.useRef(e);return t.current=e,u.useCallback(n=>{const o=t.current;let r=!1;const s=o.map(i=>{const c=Mt(i,n);return!r&&typeof c=="function"&&(r=!0),c});if(r)return()=>{for(let i=0;i<s.length;i++){const c=s[i];typeof c=="function"?c():Mt(o[i],null)}}},[])}function ae(e){return(e==null?void 0:e.animationName)||"none"}function Xs(e){var o,r;let t=(o=Object.getOwnPropertyDescriptor(e.props,"ref"))==null?void 0:o.get,n=t&&"isReactWarning"in t&&t.isReactWarning;return n?e.ref:(t=(r=Object.getOwnPropertyDescriptor(e,"ref"))==null?void 0:r.get,n=t&&"isReactWarning"in t&&t.isReactWarning,n?e.props.ref:e.props.ref||e.ref)}var Zs=Ie[" useInsertionEffect ".trim().toString()]||B;function Gs({prop:e,defaultProp:t,onChange:n=()=>{},caller:o}){const[r,s,i]=Ks({defaultProp:t,onChange:n}),c=e!==void 0,a=c?e:r;{const l=u.useRef(e!==void 0);u.useEffect(()=>{const d=l.current;d!==c&&console.warn(`${o} is changing from ${d?"controlled":"uncontrolled"} to ${c?"controlled":"uncontrolled"}. Components should not switch from controlled to uncontrolled (or vice versa). Decide between using a controlled or uncontrolled value for the lifetime of the component.`),l.current=c},[c,o])}const f=u.useCallback(l=>{var d;if(c){const p=Qs(l)?l(e):l;p!==e&&((d=i.current)==null||d.call(i,p))}else s(l)},[c,e,s,i]);return[a,f]}function Ks({defaultProp:e,onChange:t}){const[n,o]=u.useState(e),r=u.useRef(n),s=u.useRef(t);return Zs(()=>{s.current=t},[t]),u.useEffect(()=>{var i;r.current!==n&&((i=s.current)==null||i.call(s,n),r.current=n)},[n,r]),[n,o,s]}function Qs(e){return typeof e=="function"}var Js=Object.freeze({position:"absolute",border:0,width:1,height:1,padding:0,margin:-1,overflow:"hidden",clip:"rect(0, 0, 0, 0)",whiteSpace:"nowrap",wordWrap:"normal"}),ei="VisuallyHidden",Qt=u.forwardRef((e,t)=>R.jsx(Q.span,{...e,ref:t,style:{...Js,...e.style}}));Qt.displayName=ei;var ti=Qt,[Ee]=_t("Tooltip",[Ft]),Pe=Ft(),Jt="TooltipProvider",ni=700,ze="tooltip.open",[oi,Qe]=Ee(Jt),en=e=>{const{__scopeTooltip:t,delayDuration:n=ni,skipDelayDuration:o=300,disableHoverableContent:r=!1,children:s}=e,i=u.useRef(!0),c=u.useRef(!1),a=u.useRef(0);return u.useEffect(()=>{const f=a.current;return()=>window.clearTimeout(f)},[]),R.jsx(oi,{scope:t,isOpenDelayedRef:i,delayDuration:n,onOpen:u.useCallback(()=>{o<=0||(window.clearTimeout(a.current),i.current=!1)},[o]),onClose:u.useCallback(()=>{o<=0||(window.clearTimeout(a.current),a.current=window.setTimeout(()=>i.current=!0,o))},[o]),isPointerInTransitRef:c,onPointerInTransitChange:u.useCallback(f=>{c.current=f},[]),disableHoverableContent:r,children:s})};en.displayName=Jt;var ue="Tooltip",[ri,fe]=Ee(ue),tn=e=>{const{__scopeTooltip:t,children:n,open:o,defaultOpen:r,onOpenChange:s,disableHoverableContent:i,delayDuration:c}=e,a=Qe(ue,e.__scopeTooltip),f=Pe(t),[l,d]=u.useState(null),p=_r(),h=u.useRef(0),y=i??a.disableHoverableContent,m=c??a.delayDuration,g=u.useRef(!1),[x,k]=Gs({prop:o,defaultProp:r??!1,onChange:_=>{_?(a.onOpen(),document.dispatchEvent(new CustomEvent(ze))):a.onClose(),s==null||s(_)},caller:ue}),w=u.useMemo(()=>x?g.current?"delayed-open":"instant-open":"closed",[x]),b=u.useCallback(()=>{window.clearTimeout(h.current),h.current=0,g.current=!1,k(!0)},[k]),C=u.useCallback(()=>{window.clearTimeout(h.current),h.current=0,k(!1)},[k]),M=u.useCallback(()=>{window.clearTimeout(h.current),h.current=window.setTimeout(()=>{g.current=!0,k(!0),h.current=0},m)},[m,k]);return u.useEffect(()=>()=>{h.current&&(window.clearTimeout(h.current),h.current=0)},[]),R.jsx(Is,{...f,children:R.jsx(ri,{scope:t,contentId:p,open:x,stateAttribute:w,trigger:l,onTriggerChange:d,onTriggerEnter:u.useCallback(()=>{a.isOpenDelayedRef.current?M():b()},[a.isOpenDelayedRef,M,b]),onTriggerLeave:u.useCallback(()=>{y?C():(window.clearTimeout(h.current),h.current=0)},[C,y]),onOpen:b,onClose:C,disableHoverableContent:y,children:n})})};tn.displayName=ue;var He="TooltipTrigger",nn=u.forwardRef((e,t)=>{const{__scopeTooltip:n,...o}=e,r=fe(He,n),s=Qe(He,n),i=Pe(n),c=u.useRef(null),a=oe(t,c,r.onTriggerChange),f=u.useRef(!1),l=u.useRef(!1),d=u.useCallback(()=>f.current=!1,[]);return u.useEffect(()=>()=>document.removeEventListener("pointerup",d),[d]),R.jsx(Vs,{asChild:!0,...i,children:R.jsx(Q.button,{"aria-describedby":r.open?r.contentId:void 0,"data-state":r.stateAttribute,...o,ref:a,onPointerMove:q(e.onPointerMove,p=>{p.pointerType!=="touch"&&!l.current&&!s.isPointerInTransitRef.current&&(r.onTriggerEnter(),l.current=!0)}),onPointerLeave:q(e.onPointerLeave,()=>{r.onTriggerLeave(),l.current=!1}),onPointerDown:q(e.onPointerDown,()=>{r.open&&r.onClose(),f.current=!0,document.addEventListener("pointerup",d,{once:!0})}),onFocus:q(e.onFocus,()=>{f.current||r.onOpen()}),onBlur:q(e.onBlur,r.onClose),onClick:q(e.onClick,r.onClose)})})});nn.displayName=He;var Je="TooltipPortal",[si,ii]=Ee(Je,{forceMount:void 0}),on=e=>{const{__scopeTooltip:t,forceMount:n,children:o,container:r}=e,s=fe(Je,t);return R.jsx(si,{scope:t,forceMount:n,children:R.jsx(Ke,{present:n||s.open,children:R.jsx(Kt,{asChild:!0,container:r,children:o})})})};on.displayName=Je;var se="TooltipContent",rn=u.forwardRef((e,t)=>{const n=ii(se,e.__scopeTooltip),{forceMount:o=n.forceMount,side:r="top",...s}=e,i=fe(se,e.__scopeTooltip);return R.jsx(Ke,{present:o||i.open,children:i.disableHoverableContent?R.jsx(sn,{side:r,...s,ref:t}):R.jsx(ci,{side:r,...s,ref:t})})}),ci=u.forwardRef((e,t)=>{const n=fe(se,e.__scopeTooltip),o=Qe(se,e.__scopeTooltip),r=u.useRef(null),s=oe(t,r),[i,c]=u.useState(null),{trigger:a,onClose:f}=n,l=r.current,{onPointerInTransitChange:d}=o,p=u.useCallback(()=>{c(null),d(!1)},[d]),h=u.useCallback((y,m)=>{const g=y.currentTarget,x={x:y.clientX,y:y.clientY},k=ui(x,g.getBoundingClientRect()),w=fi(x,k),b=hi(m.getBoundingClientRect()),C=yi([...w,...b]);c(C),d(!0)},[d]);return u.useEffect(()=>()=>p(),[p]),u.useEffect(()=>{if(a&&l){const y=g=>h(g,l),m=g=>h(g,a);return a.addEventListener("pointerleave",y),l.addEventListener("pointerleave",m),()=>{a.removeEventListener("pointerleave",y),l.removeEventListener("pointerleave",m)}}},[a,l,h,p]),u.useEffect(()=>{if(i){const y=m=>{const g=m.target,x={x:m.clientX,y:m.clientY},k=(a==null?void 0:a.contains(g))||(l==null?void 0:l.contains(g)),w=!pi(x,i);k?p():w&&(p(),f())};return document.addEventListener("pointermove",y),()=>document.removeEventListener("pointermove",y)}},[a,l,i,f,p]),R.jsx(sn,{...e,ref:s})}),[ai,li]=Ee(ue,{isInside:!1}),di=rr("TooltipContent"),sn=u.forwardRef((e,t)=>{const{__scopeTooltip:n,children:o,"aria-label":r,onEscapeKeyDown:s,onPointerDownOutside:i,...c}=e,a=fe(se,n),f=Pe(n),{onClose:l}=a;return u.useEffect(()=>(document.addEventListener(ze,l),()=>document.removeEventListener(ze,l)),[l]),u.useEffect(()=>{if(a.trigger){const d=p=>{p.target instanceof Node&&p.target.contains(a.trigger)&&l()};return window.addEventListener("scroll",d,{capture:!0}),()=>window.removeEventListener("scroll",d,{capture:!0})}},[a.trigger,l]),R.jsx(Et,{asChild:!0,disableOutsidePointerEvents:!1,onEscapeKeyDown:s,onPointerDownOutside:i,onFocusOutside:d=>d.preventDefault(),onDismiss:l,children:R.jsxs(Ws,{"data-state":a.stateAttribute,...f,...c,ref:t,style:{...c.style,"--radix-tooltip-content-transform-origin":"var(--radix-popper-transform-origin)","--radix-tooltip-content-available-width":"var(--radix-popper-available-width)","--radix-tooltip-content-available-height":"var(--radix-popper-available-height)","--radix-tooltip-trigger-width":"var(--radix-popper-anchor-width)","--radix-tooltip-trigger-height":"var(--radix-popper-anchor-height)"},children:[R.jsx(di,{children:o}),R.jsx(ai,{scope:n,isInside:!0,children:R.jsx(ti,{id:a.contentId,role:"tooltip",children:r||o})})]})})});rn.displayName=se;var cn="TooltipArrow",an=u.forwardRef((e,t)=>{const{__scopeTooltip:n,...o}=e,r=Pe(n);return li(cn,n).isInside?null:R.jsx(Fs,{...r,...o,ref:t})});an.displayName=cn;function ui(e,t){const n=Math.abs(t.top-e.y),o=Math.abs(t.bottom-e.y),r=Math.abs(t.right-e.x),s=Math.abs(t.left-e.x);switch(Math.min(n,o,r,s)){case s:return"left";case r:return"right";case n:return"top";case o:return"bottom";default:throw new Error("unreachable")}}function fi(e,t,n=5){const o=[];switch(t){case"top":o.push({x:e.x-n,y:e.y+n},{x:e.x+n,y:e.y+n});break;case"bottom":o.push({x:e.x-n,y:e.y-n},{x:e.x+n,y:e.y-n});break;case"left":o.push({x:e.x+n,y:e.y-n},{x:e.x+n,y:e.y+n});break;case"right":o.push({x:e.x-n,y:e.y-n},{x:e.x-n,y:e.y+n});break}return o}function hi(e){const{top:t,right:n,bottom:o,left:r}=e;return[{x:r,y:t},{x:n,y:t},{x:n,y:o},{x:r,y:o}]}function pi(e,t){const{x:n,y:o}=e;let r=!1;for(let s=0,i=t.length-1;s<t.length;i=s++){const c=t[s],a=t[i],f=c.x,l=c.y,d=a.x,p=a.y;l>o!=p>o&&n<(d-f)*(o-l)/(p-l)+f&&(r=!r)}return r}function yi(e){const t=e.slice();return t.sort((n,o)=>n.x<o.x?-1:n.x>o.x?1:n.y<o.y?-1:n.y>o.y?1:0),mi(t)}function mi(e){if(e.length<=1)return e.slice();const t=[];for(let o=0;o<e.length;o++){const r=e[o];for(;t.length>=2;){const s=t[t.length-1],i=t[t.length-2];if((s.x-i.x)*(r.y-i.y)>=(s.y-i.y)*(r.x-i.x))t.pop();else break}t.push(r)}t.pop();const n=[];for(let o=e.length-1;o>=0;o--){const r=e[o];for(;n.length>=2;){const s=n[n.length-1],i=n[n.length-2];if((s.x-i.x)*(r.y-i.y)>=(s.y-i.y)*(r.x-i.x))n.pop();else break}n.push(r)}return n.pop(),t.length===1&&n.length===1&&t[0].x===n[0].x&&t[0].y===n[0].y?t:t.concat(n)}var Xc=en,Zc=tn,Gc=nn,Kc=on,Qc=rn,Jc=an;export{Vc as $,Mi as A,_i as B,Oi as C,Bi as D,Pi as E,oc as F,Ai as G,cc as H,gi as I,Gi as J,Ci as K,pc as L,xc as M,ec as N,Cc as O,Rc as P,Ki as Q,Oc as R,Sc as S,tc as T,Fc as U,Zi as V,Bc as W,Yc as X,Uc as Y,rc as Z,Si as _,Vi as a,Fi as a0,Ec as a1,ac as a2,Tc as a3,$i as a4,qc as a5,Ji as a6,Hc as a7,Lc as a8,Nc as a9,Di as aa,Hi as ab,Ii as ac,bi as ad,lc as ae,qi as af,Xc as ag,Zc as ah,Gc as ai,Kc as aj,Qc as ak,Jc as al,ic as am,Ic as an,Wc as ao,Ei as ap,yc as aq,ki as ar,gc as as,mc as at,Mc as au,ji as av,bc as aw,xi as ax,Yi as ay,Xi as az,vc as b,Qi as c,dc as d,fc as e,Ti as f,Pc as g,Ac as h,_c as i,Ni as j,hc as k,zi as l,$c as m,wi as n,Ri as o,jc as p,uc as q,kc as r,Dc as s,nc as t,Li as u,wc as v,Ui as w,zc as x,Wi as y,sc as z};
