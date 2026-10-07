const{onCall,HttpsError}=require("firebase-functions/v2/https");
const{setGlobalOptions}=require("firebase-functions/v2");
const admin=require("firebase-admin");
const crypto=require("crypto");
const Razorpay=require("razorpay");

admin.initializeApp();
setGlobalOptions({region:"asia-south1",maxInstances:10,enforceAppCheck:true});
const db=admin.firestore();

async function redis(command,args=[]){
  const url=process.env.UPSTASH_REDIS_REST_URL,token=process.env.UPSTASH_REDIS_REST_TOKEN;
  if(!url||!token)throw new HttpsError("failed-precondition","Redis security service is not configured.");
  const r=await fetch(url,{method:"POST",headers:{"Authorization":"Bearer "+token,"Content-Type":"application/json"},body:JSON.stringify([command,...args])});
  if(!r.ok)throw new HttpsError("unavailable","Security service unavailable.");
  return (await r.json()).result;
}
async function limit(uid,action,max,windowSeconds){
  const key="rate:"+action+":"+uid;
  const count=await redis("INCR",[key]);
  if(count===1)await redis("EXPIRE",[key,windowSeconds]);
  if(Number(count)>max)throw new HttpsError("resource-exhausted","Too many requests. Try again later.");
}
function user(r){if(!r.auth)throw new HttpsError("unauthenticated","Login required.");return r.auth.uid}

exports.createRazorpayOrder=onCall({enforceAppCheck:true},async r=>{
  const uid=user(r);await limit(uid,"create-order",5,60);
  const{bookId}=r.data||{};
  if(!bookId||typeof bookId!=="string")throw new HttpsError("invalid-argument","Invalid book.");
  const b=await db.doc("books/"+bookId).get();
  if(!b.exists||b.data().status!=="ACTIVE")throw new HttpsError("not-found","Book not found.");
  const price=Number(b.data().price);
  if(!Number.isSafeInteger(Math.round(price*100))||price<1)throw new HttpsError("failed-precondition","Invalid price.");
  const own=await db.doc("purchases/"+uid+"_"+bookId).get();
  if(own.exists&&own.data().status==="PAID")throw new HttpsError("already-exists","Already purchased.");
  if(!process.env.RAZORPAY_KEY_ID||!process.env.RAZORPAY_KEY_SECRET)throw new HttpsError("failed-precondition","Payment gateway is not configured.");
  const idem="order:"+uid+":"+bookId;
  const lock=await redis("SET",[idem,"1","NX","EX",30]);
  if(lock===null)throw new HttpsError("aborted","Order creation already in progress.");
  try{
    const rz=new Razorpay({key_id:process.env.RAZORPAY_KEY_ID,key_secret:process.env.RAZORPAY_KEY_SECRET});
    const o=await rz.orders.create({amount:Math.round(price*100),currency:"INR",receipt:("ebook_"+uid+"_"+bookId+"_"+Date.now()).slice(0,40),notes:{uid,bookId}});
    await db.doc("orders/"+o.id).set({userId:uid,bookId,amount:price,amountPaise:o.amount,status:"CREATED",gatewayOrderId:o.id,createdAt:admin.firestore.FieldValue.serverTimestamp()});
    return{key:process.env.RAZORPAY_KEY_ID,order_id:o.id,amount:o.amount,currency:o.currency,name:"MS Tech EBook",description:b.data().title};
  }finally{await redis("DEL",[idem]).catch(()=>{});}
});

exports.verifyRazorpayPayment=onCall({enforceAppCheck:true},async r=>{
  const uid=user(r);await limit(uid,"verify-payment",10,60);
  const{bookId,razorpay_order_id,razorpay_payment_id,razorpay_signature}=r.data||{};
  if(!bookId||!razorpay_order_id||!razorpay_payment_id||!razorpay_signature)throw new HttpsError("invalid-argument","Incomplete payment response.");
  const o=await db.doc("orders/"+razorpay_order_id).get();
  if(!o.exists||o.data().userId!==uid||o.data().bookId!==bookId)throw new HttpsError("permission-denied","Invalid order.");
  if(o.data().status==="PAID")return{success:true};
  const expected=crypto.createHmac("sha256",process.env.RAZORPAY_KEY_SECRET).update(razorpay_order_id+"|"+razorpay_payment_id).digest("hex");
  const a=Buffer.from(expected,"utf8"),b=Buffer.from(String(razorpay_signature),"utf8");
  if(a.length!==b.length||!crypto.timingSafeEqual(a,b))throw new HttpsError("permission-denied","Payment verification failed.");
  const paymentKey="payment:"+razorpay_payment_id;
  const claimed=await redis("SET",[paymentKey,uid,"NX","EX",86400]);
  if(claimed===null){
    const purchase=await db.doc("purchases/"+uid+"_"+bookId).get();
    if(purchase.exists&&purchase.data().status==="PAID")return{success:true};
    throw new HttpsError("already-exists","Payment has already been processed.");
  }
  const rz=new Razorpay({key_id:process.env.RAZORPAY_KEY_ID,key_secret:process.env.RAZORPAY_KEY_SECRET});
  const payment=await rz.payments.fetch(razorpay_payment_id);
  if(payment.order_id!==razorpay_order_id||payment.status!=="captured"||Number(payment.amount)!==Number(o.data().amountPaise))throw new HttpsError("failed-precondition","Payment is not captured or amount is invalid.");
  await db.runTransaction(async tx=>{
    const purchaseRef=db.doc("purchases/"+uid+"_"+bookId);
    const current=await tx.get(purchaseRef);
    if(current.exists&&current.data().status==="PAID")return;
    tx.set(purchaseRef,{userId:uid,bookId,orderId:razorpay_order_id,paymentId:razorpay_payment_id,amount:o.data().amount,status:"PAID",purchasedAt:admin.firestore.FieldValue.serverTimestamp()},{merge:true});
    tx.update(o.ref,{status:"PAID",paymentId:razorpay_payment_id,paidAt:admin.firestore.FieldValue.serverTimestamp()});
  });
  return{success:true};
});

exports.getSecureBookUrl=onCall({enforceAppCheck:true},async r=>{
  const uid=user(r);await limit(uid,"read-url",30,60);
  const{bookId}=r.data||{};
  if(!bookId||typeof bookId!=="string")throw new HttpsError("invalid-argument","Invalid book.");
  const purchase=await db.doc("purchases/"+uid+"_"+bookId).get();
  if(!purchase.exists||purchase.data().status!=="PAID")throw new HttpsError("permission-denied","Purchase required.");
  const book=await db.doc("books/"+bookId).get();
  if(!book.exists||!book.data().storagePath)throw new HttpsError("not-found","Ebook file not found.");
  const file=admin.storage().bucket().file(book.data().storagePath);
  const[url]=await file.getSignedUrl({action:"read",expires:Date.now()+5*60*1000,responseDisposition:"inline"});
  return{url,expiresIn:300};
});