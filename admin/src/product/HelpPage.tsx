import officialQr from '../../public/wecom-helper.jpg';
import serviceQr from '../../public/customer-service-qr.png';
import donationQr from '../../public/wechat-donation.jpg';
import React, { useState } from 'react';
import { HeartHandshake, ArrowLeft } from 'lucide-react';

export function HelpPage() {
  const [donate, setDonate] = useState(false);
  return <section className="product-help"><header><h1>{donate ? '支持 PMBrain' : '使用帮助'}</h1><p>{donate ? '你的支持是产品持续更新的动力。' : '关注产品更新，或添加客服协助处理使用问题。'}</p></header>
    {donate ? <div className="help-donate"><img src={donationQr} alt="微信支付收款二维码" /><button onClick={() => setDonate(false)}><ArrowLeft size={16} />返回使用帮助</button></div> : <><div className="help-contacts"><article><span>产品动态</span><h2>关注开发者公众号</h2><p>获取使用方法和最新信息</p><img src={officialQr} alt="PMBrain 开发者公众号二维码" /></article><article><span>问题处理</span><h2>添加客服好友</h2><p>遇到问题，扫码添加客服</p><img src={serviceQr} alt="客服微信二维码" /></article></div><div className="help-support"><div><h2>愿意支持 PMBrain？</h2><p>认为产品还不错的话可进行赞赏，你的支持是产品更新的动力。</p></div><button onClick={() => setDonate(true)}><HeartHandshake size={17} />赞赏支持</button></div></>}
  </section>;
}
