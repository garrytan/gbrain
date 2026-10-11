function c(t,r){if(t.target!==t.currentTarget)return;const i=t.currentTarget.getBoundingClientRect();(t.clientX<i.left||t.clientX>i.right||t.clientY<i.top||t.clientY>i.bottom)&&r()}export{c as d};
