import React, { useEffect, useMemo, useRef, useState } from "react";
// Self-contained navigation: this project does not require react-router-dom.
// Using the History API keeps the App.jsx compatible with the original package.json.
function useLocation(){
  const [pathname,setPathname]=useState(()=>window.location.pathname);
  useEffect(()=>{
    const onPop=()=>setPathname(window.location.pathname);
    window.addEventListener("popstate",onPop);
    return()=>window.removeEventListener("popstate",onPop);
  },[]);
  return {pathname};
}

function useNavigate(){
  return (to, options={})=>{
    const target=String(to||"/");
    if(options.replace) window.history.replaceState({},"",target);
    else window.history.pushState({},"",target);
    window.dispatchEvent(new PopStateEvent("popstate"));
    window.scrollTo({top:0,behavior:"auto"});
  };
}

function Link({to,children,className,onClick,...props}){
  const navigate=useNavigate();
  function handleClick(e){
    if(onClick) onClick(e);
    if(e.defaultPrevented) return;
    if(e.button!==0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(to);
  }
  return <a href={to} className={className} onClick={handleClick} {...props}>{children}</a>;
}

function Navigate({to,replace=false}){
  const navigate=useNavigate();
  useEffect(()=>{navigate(to,{replace});},[to,replace]);
  return null;
}

const IconBase=({children,className="",...props})=><span className={`ta-icon ${className}`} aria-hidden="true" {...props}>{children}</span>;
const ArrowRight=({className,...p})=><IconBase className={className} {...p}>→</IconBase>;
const BarChart3=({className,...p})=><IconBase className={className} {...p}>▥</IconBase>;
const BadgeCheck=({className,...p})=><IconBase className={className} {...p}>✓</IconBase>;
const CalendarDays=({className,...p})=><IconBase className={className} {...p}>▦</IconBase>;
const Check=({className,...p})=><IconBase className={className} {...p}>✓</IconBase>;
const CheckCircle2=({className,...p})=><IconBase className={className} {...p}>●</IconBase>;
const Copy=({className,...p})=><IconBase className={className} {...p}>▣</IconBase>;
const CreditCard=({className,...p})=><IconBase className={className} {...p}>▭</IconBase>;
const Crown=({className,...p})=><IconBase className={className} {...p}>♛</IconBase>;
const DollarSign=({className,...p})=><IconBase className={className} {...p}>$</IconBase>;
const Eye=({className,...p})=><IconBase className={className} {...p}>◉</IconBase>;
const FileImage=({className,...p})=><IconBase className={className} {...p}>▧</IconBase>;
const LogOut=({className,...p})=><IconBase className={className} {...p}>↪</IconBase>;
const Mail=({className,...p})=><IconBase className={className} {...p}>✉</IconBase>;
const Menu=({className,...p})=><IconBase className={className} {...p}>☰</IconBase>;
const Plus=({className,...p})=><IconBase className={className} {...p}>+</IconBase>;
const RotateCcw=({className,...p})=><IconBase className={className} {...p}>↻</IconBase>;
const Save=({className,...p})=><IconBase className={className} {...p}>▣</IconBase>;
const Search=({className,...p})=><IconBase className={className} {...p}>⌕</IconBase>;
const ShieldCheck=({className,...p})=><IconBase className={className} {...p}>◇</IconBase>;
const Upload=({className,...p})=><IconBase className={className} {...p}>↑</IconBase>;
const Users=({className,...p})=><IconBase className={className} {...p}>♟</IconBase>;
const Wallet=({className,...p})=><IconBase className={className} {...p}>▱</IconBase>;
const Lock=({className,...p})=><IconBase className={className} {...p}>▣</IconBase>;
const Unlock=({className,...p})=><IconBase className={className} {...p}>□</IconBase>;
const X=({className,...p})=><IconBase className={className} {...p}>×</IconBase>;
const XCircle=({className,...p})=><IconBase className={className} {...p}>⊗</IconBase>;

import { supabase } from "./supabaseClient.js";

const PLAN_ORDER = Array.from({length: 100}, (_, i) => `Plan ${i + 1}`);
const MAX_SLIP_SIZE = 5 * 1024 * 1024;
const PAYMENT_SLIP_BUCKET = "payment-slips";
const DEFAULT_DAILY_EARNING_RATE = 0.10;
const EARNINGS_STORAGE_PREFIX = "rh_customer_earnings_v2_";
const INITIAL_EARNING_CREDIT_PREFIX = "rh_initial_earning_credited_v1_";
const CUSTOMER_PROFILE_SEEN_PREFIX = "rh_customer_profile_seen_v1_";
const WITHDRAWAL_ACCOUNT_PREFIX = "WITHDRAWAL_ACCOUNT_V1:";

function encodeWithdrawalAccountDetails(method, holderName, accountNumber){
  return `${WITHDRAWAL_ACCOUNT_PREFIX}${JSON.stringify({
    method:String(method||"").trim(),
    holderName:String(holderName||"").trim(),
    accountNumber:String(accountNumber||"").trim()
  })}`;
}

function decodeWithdrawalAccountDetails(row){
  // Current schema has dedicated columns. Keep the old encoded format as a
  // compatibility fallback for requests created by older App.jsx versions.
  if(row?.account_name || row?.account_number){
    return {
      method:String(row?.payment_method||""),
      holderName:String(row?.account_name||row?.account_holder_name||""),
      accountNumber:String(row?.account_number||"")
    };
  }
  const raw=String(row?.payment_method||"");
  if(raw.startsWith(WITHDRAWAL_ACCOUNT_PREFIX)){
    try{
      const value=JSON.parse(raw.slice(WITHDRAWAL_ACCOUNT_PREFIX.length));
      return {
        method:String(value?.method||""),
        holderName:String(value?.holderName||""),
        accountNumber:String(value?.accountNumber||row?.account_number||"")
      };
    }catch{}
  }
  return {
    method:raw,
    holderName:String(row?.account_holder_name||""),
    accountNumber:String(row?.account_number||"")
  };
}

const EARNING_INTERVAL_MS = 24 * 60 * 60 * 1000;

// Prevent React StrictMode / repeated dashboard refreshes from crediting the
// first earning more than once while the database write is in progress.
const initialEarningCreditInFlight = new Set();
const walletWriteInFlight = new Set();

function initialEarningCreditKey(userId, planId){
  return `${INITIAL_EARNING_CREDIT_PREFIX}${userId}_${planId}`;
}

function initialEarningWasCredited(userId, planId){
  try{return localStorage.getItem(initialEarningCreditKey(userId,planId)) === "1";}catch{return false;}
}

function markInitialEarningCredited(userId, planId){
  try{localStorage.setItem(initialEarningCreditKey(userId,planId),"1");}catch{}
}

function clearInitialEarningCredit(userId, planId){
  try{localStorage.removeItem(initialEarningCreditKey(userId,planId));}catch{}
}
const DEFAULT_ADMIN_COMMISSION_RATE = 5;
const MIN_ADMIN_COMMISSION_RATE = 5;
const MAX_ADMIN_COMMISSION_RATE = 20;
const DEFAULT_REFERRAL_COMMISSION_RATE = 5;
const MIN_REFERRAL_COMMISSION_RATE = 2;
const MAX_REFERRAL_COMMISSION_RATE = 10;
const DEFAULT_REFERRAL_COMMISSION_TIMING = "one_time";
const REFERRAL_SETTINGS_STORAGE_KEY = "rh_referral_settings_v1";
const ADMIN_COMMISSION_STORAGE_KEY = "rh_admin_commission_rate_v2";
const REFERRAL_WITHDRAWAL_PERCENTAGE_STORAGE_KEY = "rh_referral_withdrawal_percentage_v1";
const DEFAULT_REFERRAL_WITHDRAWAL_PERCENTAGE = 80;

function getReferralWithdrawalPercentage(){
  try{
    const n=Number(localStorage.getItem(REFERRAL_WITHDRAWAL_PERCENTAGE_STORAGE_KEY));
    return Number.isFinite(n)&&n>=1&&n<=100?n:DEFAULT_REFERRAL_WITHDRAWAL_PERCENTAGE;
  }catch{return DEFAULT_REFERRAL_WITHDRAWAL_PERCENTAGE;}
}

function saveReferralWithdrawalPercentage(value){
  const n=Math.min(100,Math.max(1,Number(value)||DEFAULT_REFERRAL_WITHDRAWAL_PERCENTAGE));
  try{localStorage.setItem(REFERRAL_WITHDRAWAL_PERCENTAGE_STORAGE_KEY,String(n));}catch{}
  return n;
}

// TA777Gaming stores the administrator's withdrawal-unlock percentage in
// platform_settings. localStorage is only a compatibility fallback; it must
// never override the server setting.
async function getReferralWithdrawalPercentageRemote(){
  // Use a SECURITY DEFINER RPC so customer RLS cannot hide the administrator's
  // platform setting. Fall back to the legacy local value only if the RPC is
  // unavailable during an older deployment.
  try{
    const r=await supabase.rpc("rh_get_referral_withdrawal_percent");
    const n=Number(r.data);
    if(!r.error&&Number.isFinite(n)&&n>=1&&n<=100){
      try{localStorage.setItem(REFERRAL_WITHDRAWAL_PERCENTAGE_STORAGE_KEY,String(n));}catch{}
      return n;
    }
  }catch{}
  try{
    const r=await supabase.from("platform_settings")
      .select("setting_value")
      .eq("setting_name","referral_withdrawal_percent")
      .maybeSingle();
    if(!r.error){
      const n=Number(r.data?.setting_value);
      if(Number.isFinite(n)&&n>=1&&n<=100){
        try{localStorage.setItem(REFERRAL_WITHDRAWAL_PERCENTAGE_STORAGE_KEY,String(n));}catch{}
        return n;
      }
    }
  }catch{}
  return getReferralWithdrawalPercentage();
}

async function saveReferralWithdrawalPercentageRemote(value){
  const n=Math.min(100,Math.max(1,Number(value)||DEFAULT_REFERRAL_WITHDRAWAL_PERCENTAGE));
  const r=await supabase.rpc("rh_set_referral_withdrawal_percent",{p_percent:n});
  if(r.error)throw r.error;
  const saved=Number(r.data);
  if(!Number.isFinite(saved)||saved<1||saved>100)throw new Error("The server returned an invalid referral withdrawal percentage.");
  try{localStorage.setItem(REFERRAL_WITHDRAWAL_PERCENTAGE_STORAGE_KEY,String(saved));}catch{}
  return saved;
}

function planNumber(plan, fallbackIndex = 0){
  const name=String(plan?.name||"").trim();
  const match=name.match(/^plan\s*(\d+)$/i);
  if(match) return Number(match[1]);
  return fallbackIndex + 1;
}

function sortPlans(list){
  return [...(list||[])].sort((a,b)=>planNumber(a)-planNumber(b) || String(a.name||"").localeCompare(String(b.name||"")));
}

function planLabel(plan, index=0){ return `Plan ${planNumber(plan,index)}`; }


function getAdminCommissionRate(){
  try{
    const raw=Number(localStorage.getItem(ADMIN_COMMISSION_STORAGE_KEY));
    return Number.isFinite(raw)&&raw>=MIN_ADMIN_COMMISSION_RATE&&raw<=MAX_ADMIN_COMMISSION_RATE?raw:DEFAULT_ADMIN_COMMISSION_RATE;
  }catch{return DEFAULT_ADMIN_COMMISSION_RATE;}
}

function saveAdminCommissionRate(value){
  const rate=Math.min(MAX_ADMIN_COMMISSION_RATE,Math.max(MIN_ADMIN_COMMISSION_RATE,Number(value)||DEFAULT_ADMIN_COMMISSION_RATE));
  try{localStorage.setItem(ADMIN_COMMISSION_STORAGE_KEY,String(rate));}catch{}
  return rate;
}

function getReferralSettings(){
  try{
    const raw=JSON.parse(localStorage.getItem(REFERRAL_SETTINGS_STORAGE_KEY)||"{}");
    const rate=Number(raw.rate);
    return {rate:Number.isFinite(rate)&&rate>=MIN_REFERRAL_COMMISSION_RATE&&rate<=MAX_REFERRAL_COMMISSION_RATE?rate:DEFAULT_REFERRAL_COMMISSION_RATE,timing:raw.timing==="every_24_hours"?"every_24_hours":DEFAULT_REFERRAL_COMMISSION_TIMING};
  }catch{return {rate:DEFAULT_REFERRAL_COMMISSION_RATE,timing:DEFAULT_REFERRAL_COMMISSION_TIMING};}
}
function saveReferralSettings(rate,timing){
  const next={rate:Math.min(MAX_REFERRAL_COMMISSION_RATE,Math.max(MIN_REFERRAL_COMMISSION_RATE,Number(rate)||DEFAULT_REFERRAL_COMMISSION_RATE)),timing:timing==="every_24_hours"?"every_24_hours":DEFAULT_REFERRAL_COMMISSION_TIMING};
  try{localStorage.setItem(REFERRAL_SETTINGS_STORAGE_KEY,JSON.stringify(next));}catch{}
  return next;
}

async function saveReferralRelationship(userId, referralCode){
  const code=String(referralCode||"").trim();
  if(!userId||!code)return false;

  // Canonical TA777Gaming path. This SECURITY DEFINER RPC is required because
  // customer profile RLS intentionally lets a customer read only their own row.
  try{
    const rpc=await supabase.rpc("rh_set_referrer",{
      p_customer_id:userId,
      p_referral_code:code
    });
    if(!rpc.error && rpc.data!==false)return true;
  }catch{}

  // Compatibility fallback for older deployments.
  try{
    const lookup=await supabase.from("profiles").select("id").eq("referral_code",code).maybeSingle();
    if(lookup.error||!lookup.data||lookup.data.id===userId)return false;
    const result=await supabase.from("profiles").update({referred_by:lookup.data.id}).eq("id",userId);
    return !result.error;
  }catch{}
  return false;
}

async function getReferredCustomers(userId){
  if(!userId)return {rows:[],tracked:false};

  const rowsById=new Map();
  let tracked=false;

  // The referral relationship can exist in several TA777Gaming database
  // versions. We intentionally try the relationship tables first because they
  // are often readable by the referrer even when profiles RLS hides another
  // customer's profile row.
  const relationshipSources=[
    {table:"referrals", referrerColumns:["referrer_id","user_id"], referredColumns:["referred_user_id","referred_customer_id","customer_id"]},
    {table:"referral_commissions", referrerColumns:["referrer_id","user_id"], referredColumns:["referred_user_id","referred_customer_id","customer_id"]}
  ];

  const addIds=async(ids)=>{
    for(const id of ids){
      if(!id||id===userId)continue;
      try{
        const r=await supabase.from("profiles").select("id,full_name,email,referral_code").eq("id",id).maybeSingle();
        if(!r.error&&r.data?.id)rowsById.set(r.data.id,r.data);
      }catch{}
    }
  };

  for(const source of relationshipSources){
    for(const referrerColumn of source.referrerColumns){
      for(const referredColumn of source.referredColumns){
        try{
          const r=await supabase.from(source.table).select(`${referrerColumn},${referredColumn}`).eq(referrerColumn,userId);
          if(!r.error){
            tracked=true;
            await addIds((r.data||[]).map(x=>x?.[referredColumn]));
          }
        }catch{}
      }
    }
  }

  // Read the current customer's referral code. New registrations also store
  // this code in the referred customer's profile when the schema permits it.
  let myReferralCode="";
  try{
    const me=await supabase.from("profiles").select("id,referral_code").eq("id",userId).maybeSingle();
    if(!me.error){
      myReferralCode=String(me.data?.referral_code||"").trim();
      if(myReferralCode)tracked=true;
    }
  }catch{}

  // Support every referral column used by the earlier versions. Each query
  // uses a minimal SELECT so one missing optional column cannot break it.
  const profileQueries=[
    {field:"referrer_id",value:userId},
    {field:"referred_by",value:userId},
    {field:"referred_by_user_id",value:userId},
    {field:"parent_id",value:userId},
    {field:"sponsor_id",value:userId},
    {field:"referrer_user_id",value:userId},
    ...(myReferralCode?[
      {field:"referred_by_code",value:myReferralCode},
      {field:"referral_parent_code",value:myReferralCode},
      {field:"sponsor_code",value:myReferralCode}
    ]:[])
  ];

  for(const q of profileQueries){
    try{
      const result=await supabase.from("profiles").select("id,full_name,email,referral_code").eq(q.field,q.value);
      if(!result.error){
        tracked=true;
        for(const row of (result.data||[]))if(row?.id&&row.id!==userId)rowsById.set(row.id,row);
      }
    }catch{}
  }

  // A few deployments keep the referral code in a dedicated referral table.
  // Match either a stored referrer ID or the referrer's code.
  if(myReferralCode){
    for(const source of ["referrals","referral_commissions"]){
      for(const codeColumn of ["referral_code","referrer_code","sponsor_code"]){
        for(const referredColumn of ["referred_user_id","referred_customer_id","customer_id","user_id"]){
          try{
            const r=await supabase.from(source).select(`${codeColumn},${referredColumn}`).eq(codeColumn,myReferralCode);
            if(!r.error){
              tracked=true;
              await addIds((r.data||[]).map(x=>x?.[referredColumn]).filter(id=>id&&id!==userId));
            }
          }catch{}
        }
      }
    }
  }

  return {rows:[...rowsById.values()],tracked};
}
async function getWithdrawalUnlocks(userId, withdrawals=[]){
  if(!userId)return {tracked:false,qualifying:[],usedCount:0,available:[],availableLimit:0};

  const withdrawalPercent=await getReferralWithdrawalPercentageRemote();

  // CANONICAL PATH: use the existing SECURITY DEFINER function in the real
  // TA777Gaming database. It can see referred customers even though profiles
  // RLS intentionally hides other customers from a normal customer session.
  try{
    const rpc=await supabase.rpc("rh_get_referral_withdrawal_unlocks",{p_user_id:userId});
    if(!rpc.error && Array.isArray(rpc.data)){
      const qualifying=(rpc.data||[]).map(row=>{
        const planPrice=Number(row?.plan_price||0);
        return {
          customerId:row?.customer_id,
          customerName:row?.customer_name||row?.customer_email||"Referred customer",
          email:row?.customer_email||"",
          referralCode:row?.customer_referral_code||"",
          planId:row?.plan_id,
          planName:row?.plan_name||"Plan",
          planPrice,
          withdrawLimit:Number((planPrice*withdrawalPercent/100).toFixed(2)),
          createdAt:row?.plan_created_at||row?.plan_starts_at||""
        };
      }).filter(row=>row.customerId&&Number.isFinite(row.planPrice)&&row.planPrice>0);

      qualifying.sort((a,b)=>new Date(a.createdAt||0).getTime()-new Date(b.createdAt||0).getTime());
      const usedCount=(withdrawals||[]).filter(w=>{
        const status=String(w?.status||"").toLowerCase();
        return status==="pending"||status==="approved";
      }).length;
      const available=qualifying.slice(usedCount);
      return {
        tracked:true,
        qualifying,
        usedCount,
        available,
        availableLimit:Number(available[0]?.withdrawLimit||0)
      };
    }
  }catch{}

  // FALLBACK PATH for older databases without the RPC.
  const refs=await getReferredCustomers(userId);
  const qualifying=[];
  for(const ref of refs.rows){
    try{
      let result=await supabase.from("customer_plans")
        .select("id,customer_id,plan_id,price_paid,starts_at,ends_at,created_at,status,plans(name,price,duration_days)")
        .eq("customer_id",ref.id)
        .order("created_at",{ascending:false});

      if(result.error && /price_paid|plan_id|ends_at|column|schema cache/i.test(String(result.error.message||""))){
        result=await supabase.from("customer_plans")
          .select("id,customer_id,starts_at,created_at,status,plans(name,price,duration_days)")
          .eq("customer_id",ref.id)
          .order("created_at",{ascending:false});
      }
      if(result.error)continue;

      const active=(result.data||[]).find(plan=>{
        const status=String(plan?.status||"").toLowerCase();
        if(status!=="active"&&status!=="approved")return false;
        if(plan?.ends_at){
          const endAt=new Date(plan.ends_at).getTime();
          if(Number.isFinite(endAt)&&endAt<=Date.now())return false;
        }
        return true;
      });
      if(!active)continue;

      const planPrice=Number(active.price_paid??active.plans?.price??0);
      if(!Number.isFinite(planPrice)||planPrice<=0)continue;
      qualifying.push({
        customerId:ref.id,
        customerName:ref.full_name||ref.email||"Referred customer",
        email:ref.email||"",
        referralCode:ref.referral_code||"",
        planId:active.plan_id||active.id,
        planName:active.plans?.name||"Plan",
        planPrice,
        withdrawLimit:Number((planPrice*withdrawalPercent/100).toFixed(2)),
        createdAt:active.created_at||active.starts_at||""
      });
    }catch{}
  }

  qualifying.sort((a,b)=>new Date(a.createdAt||0).getTime()-new Date(b.createdAt||0).getTime());
  const usedCount=(withdrawals||[]).filter(w=>{
    const status=String(w?.status||"").toLowerCase();
    return status==="pending"||status==="approved";
  }).length;
  const available=qualifying.slice(usedCount);
  return {tracked:refs.tracked,qualifying,usedCount,available,availableLimit:Number(available[0]?.withdrawLimit||0)};
}

async function readRemoteWalletBalance(userId){
  if(!userId)return 0;

  // The original TA777Gaming database stores the real customer wallet in
  // player_balances. customer_wallet_summary is a VIEW in some deployments,
  // so it must NEVER be written to from the browser.
  const sources=[
    {table:"player_balances",idColumns:["user_id","customer_id"],balanceColumns:["balance","current_balance","wallet_balance"]},
    {table:"wallet_balances",idColumns:["user_id","customer_id"],balanceColumns:["balance","current_balance","wallet_balance"]},
    {table:"customer_balances",idColumns:["user_id","customer_id"],balanceColumns:["balance","current_balance","wallet_balance"]},
    {table:"profiles",idColumns:["id"],balanceColumns:["current_balance","balance","wallet_balance"]}
  ];

  for(const source of sources){
    for(const idColumn of source.idColumns){
      for(const balanceColumn of source.balanceColumns){
        try{
          const r=await supabase.from(source.table)
            .select(balanceColumn)
            .eq(idColumn,userId)
            .limit(1)
            .maybeSingle();
          if(!r.error && r.data && r.data[balanceColumn]!==null && typeof r.data[balanceColumn]!=="undefined"){
            const value=Number(r.data[balanceColumn]);
            if(Number.isFinite(value))return Number(Math.max(0,value).toFixed(2));
          }
        }catch{}
      }
    }
  }

  // Read-only compatibility fallback for installations that expose only the
  // wallet summary view or transaction ledger.
  try{
    const r=await supabase.from("customer_wallet_summary")
      .select("customer_id,balance")
      .eq("customer_id",userId)
      .maybeSingle();
    if(!r.error && r.data){
      const value=Number(r.data.balance||0);
      if(Number.isFinite(value))return Number(Math.max(0,value).toFixed(2));
    }
  }catch{}

  try{
    const r=await supabase.from("customer_wallet_transactions")
      .select("transaction_type,amount")
      .eq("customer_id",userId)
      .order("created_at",{ascending:true});
    if(!r.error){
      let balance=0;
      for(const tx of (r.data||[])){
        const n=Number(tx.amount||0);
        if(!Number.isFinite(n))continue;
        const type=String(tx.transaction_type||"").toLowerCase();
        if(type.includes("withdraw")||type.includes("debit")||type.includes("deduct"))balance-=Math.abs(n);
        else balance+=Math.abs(n);
      }
      return Number(Math.max(0,balance).toFixed(2));
    }
  }catch{}

  return 0;
}

async function tryWalletRpc(userId,amount,meta={}){
  if(!userId||!Number.isFinite(Number(amount))||Number(amount)===0)return false;
  const args={
    p_user_id:userId,
    p_customer_id:userId,
    p_amount:Number(amount),
    p_transaction_type:String(meta?.transactionType||"credit"),
    p_description:String(meta?.description||"TA777Gaming wallet adjustment"),
    p_source_id:meta?.sourceId||null,
    p_source_key:meta?.sourceKey||null
  };

  for(const fn of [
    "rh_adjust_player_balance",
    "adjust_player_balance",
    "rh_adjust_customer_wallet",
    "adjust_customer_wallet",
    "increment_customer_wallet",
    "credit_customer_wallet"
  ]){
    try{
      const r=await supabase.rpc(fn,args);
      if(!r.error && r.data!==false)return true;
      const msg=String(r.error?.message||"");
      if(!/function .* does not exist|could not find the function|schema cache|PGRST202/i.test(msg))break;
    }catch{}
  }
  return false;
}

async function ensurePlayerBalanceRow(userId){
  if(!userId)return false;

  try{
    const r=await supabase.from("player_balances")
      .select("id,balance")
      .eq("user_id",userId)
      .limit(1)
      .maybeSingle();
    if(!r.error && r.data)return true;
  }catch{}

  try{
    const rpc=await supabase.rpc("ensure_player_balance",{p_user_id:userId});
    if(!rpc.error){
      const after=await supabase.from("player_balances")
        .select("id,balance")
        .eq("user_id",userId)
        .limit(1)
        .maybeSingle();
      if(!after.error && after.data)return true;
    }
  }catch{}

  try{
    const ins=await supabase.from("player_balances").insert({
      user_id:userId,
      balance:0,
      bonus_balance:0,
      total_deposited:0,
      total_withdrawn:0
    });
    if(!ins.error)return true;
  }catch{}

  return false;
}

async function incrementPersistentWalletBalance(userId,delta,meta={}){
  const amount=Number(delta||0);
  if(!userId||!Number.isFinite(amount)||amount===0)return false;

  const sourceKey=meta?.sourceKey?String(meta.sourceKey):"";
  const description=String(meta?.description||"TA777Gaming wallet adjustment");
  const transactionType=String(meta?.transactionType||(amount>=0?"credit":"debit"));
  const absAmount=Number(Math.abs(amount).toFixed(2));

  // Idempotency: the same earning/withdrawal can never be applied twice.
  if(sourceKey){
    try{
      const existing=await supabase.from("customer_wallet_transactions")
        .select("id")
        .eq("customer_id",userId)
        .eq("source_key",sourceKey)
        .limit(1)
        .maybeSingle();
      if(!existing.error && existing.data?.id)return true;
    }catch{}
  }

  // First use a server-side RPC if this database provides one.
  if(await tryWalletRpc(userId,amount,meta))return true;

  // Primary real wallet: player_balances.
  const primaryTables=[
    {table:"player_balances",idColumns:["user_id","customer_id"],balanceColumns:["balance","current_balance","wallet_balance"]},
    {table:"wallet_balances",idColumns:["user_id","customer_id"],balanceColumns:["balance","current_balance","wallet_balance"]},
    {table:"customer_balances",idColumns:["user_id","customer_id"],balanceColumns:["balance","current_balance","wallet_balance"]},
    {table:"profiles",idColumns:["id"],balanceColumns:["current_balance","balance","wallet_balance"]}
  ];

  for(const source of primaryTables){
    for(const idColumn of source.idColumns){
      for(const balanceColumn of source.balanceColumns){
        try{
          let r=await supabase.from(source.table)
            .select(`id,${balanceColumn}`)
            .eq(idColumn,userId)
            .limit(1)
            .maybeSingle();

          if(r.error||!r.data)continue;

          const current=Number(r.data[balanceColumn]||0);
          const next=Number((current+amount).toFixed(2));
          if(!Number.isFinite(current)||next<0)continue;

          const write=await supabase.from(source.table)
            .update({[balanceColumn]:next})
            .eq("id",r.data.id);

          if(!write.error){
            // Ledger is best effort. It is never allowed to make a successful
            // wallet credit/debit fail.
            if(sourceKey){
              try{
                await supabase.from("customer_wallet_transactions").insert({
                  customer_id:userId,
                  transaction_type:transactionType,
                  amount:absAmount,
                  description,
                  ...(meta?.sourceId?{source_id:meta.sourceId}:{}),
                  source_key:sourceKey
                });
              }catch{}
            }
            return true;
          }
        }catch{}
      }
    }
  }

  // Do NOT write to customer_wallet_summary. In this deployment it may be a
  // database VIEW, which is exactly what caused the "cannot insert into view"
  // error shown in the customer dashboard.
  return false;
}

async function resetPersistentWalletCompletely(userId,failures=[]){
  const errors=failures;
  const ignoreMissing=/relation .* does not exist|column .* does not exist|could not find the .* column|schema cache/i;

  // player_balances is the important table in the original TA777Gaming setup.
  // Zero ALL financial counters so ensure_player_balance or a later dashboard
  // refresh cannot restore the old wallet amount.
  const tableSpecs=[
    {table:"player_balances",columns:["user_id","customer_id"],reset:{balance:0,bonus_balance:0,total_deposited:0,total_withdrawn:0}},
    {table:"wallet_balances",columns:["user_id","customer_id"],reset:{balance:0,current_balance:0,wallet_balance:0}},
    {table:"customer_balances",columns:["user_id","customer_id"],reset:{balance:0,current_balance:0,wallet_balance:0}}
  ];

  for(const spec of tableSpecs){
    for(const idColumn of spec.columns){
      try{
        // Try all known columns in one update first. If some columns do not
        // exist, retry individually so an existing balance column is still zeroed.
        const all=await supabase.from(spec.table).update(spec.reset).eq(idColumn,userId);
        if(!all.error)continue;
        for(const column of Object.keys(spec.reset)){
          try{
            const one=await supabase.from(spec.table).update({[column]:0}).eq(idColumn,userId);
            if(one.error && !ignoreMissing.test(String(one.error.message||""))){
              // Only report a genuine existing-column/table error once per table.
              if(column==="balance")errors.push(`${spec.table}.${column}: ${one.error.message}`);
            }
          }catch(err){
            if(column==="balance")errors.push(`${spec.table}.${column}: ${err?.message||"Unknown error"}`);
          }
        }
      }catch{}
    }
  }

  // Also zero any balance column on profiles, because some deployments use it
  // as a compatibility wallet source.
  for(const column of ["current_balance","balance","wallet_balance"]){
    try{
      const r=await supabase.from("profiles").update({[column]:0}).eq("id",userId);
      if(r.error && !ignoreMissing.test(String(r.error.message||""))){
        if(column==="balance")errors.push(`profiles.${column}: ${r.error.message}`);
      }
    }catch(err){
      if(column==="balance")errors.push(`profiles.${column}: ${err?.message||"Unknown error"}`);
    }
  }
  return errors;
}

/* =========================================================
   PREMIUM VISUALS
   These styles are included here so you only need to replace
   App.jsx. They do not require a new CSS package.
========================================================= */


const premiumCss = `
/* Premium teal-violet registration and updated color system */
:root{--ta-accent:#00e5d4;--ta-violet:#5b7cff;--ta-panel:#0a1424;--ta-line:rgba(0,229,212,.25)}
.app-shell{background:radial-gradient(900px 520px at 10% -10%,rgba(0,229,212,.16),transparent 60%),radial-gradient(700px 520px at 100% 20%,rgba(91,124,255,.18),transparent 65%),linear-gradient(180deg,#06101b,#030711 72%,#02040a)}
.auth-wrap{min-height:calc(100vh - 130px);display:grid;place-items:center;padding:30px 16px 65px;background:radial-gradient(ellipse at 50% 12%,rgba(0,229,212,.10),transparent 55%)}
.ta-auth-card{width:min(100%,470px);padding:clamp(22px,5vw,38px);border:1px solid rgba(0,229,212,.27);border-radius:25px;background:linear-gradient(150deg,rgba(13,25,43,.98),rgba(5,10,22,.98));box-shadow:0 24px 90px rgba(0,0,0,.5),0 0 45px rgba(0,229,212,.08)}
.ta-auth-mark{width:70px;height:58px;display:grid;place-items:center;margin:0 auto 18px;border-radius:18px;background:linear-gradient(135deg,#00e5d4,#526dff 75%);color:#03101a;font:900 21px/1 Sora,system-ui,sans-serif;letter-spacing:-.05em;box-shadow:0 0 30px rgba(0,229,212,.22)}
.ta-auth-mark span{margin-left:3px}
.ta-auth-card>.eyebrow,.ta-auth-card>h1,.ta-auth-card>.muted{text-align:center;display:block}
.ta-auth-card>h1{font-size:clamp(26px,6vw,34px);margin:10px 0 8px;letter-spacing:-.035em}
.ta-auth-card>.muted{margin:0 0 22px;line-height:1.6}
.ta-auth-methods{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:0 0 20px;padding:5px;border:1px solid #1d3549;background:#050c18;border-radius:14px}
.ta-auth-methods button{display:flex;align-items:center;justify-content:center;gap:9px;min-height:46px;border:1px solid transparent;border-radius:10px;background:transparent;color:#a9bfd0;font-weight:800;cursor:pointer}
.ta-auth-methods button.selected{color:#eaffff;border-color:rgba(0,229,212,.45);background:linear-gradient(110deg,rgba(0,229,212,.18),rgba(91,124,255,.18));box-shadow:inset 0 0 18px rgba(0,229,212,.06)}
.ta-auth-card label{display:block;margin:15px 0;color:#d7e5f3;font-size:13px;font-weight:700}
.ta-auth-input{display:block;width:100%;margin-top:8px;padding:14px 15px;border-radius:12px;border:1px solid #233b52;background:#050c18;color:#f5fbff;outline:none;transition:border-color .18s,box-shadow .18s}
.ta-auth-input::placeholder{color:#657c92}
.ta-auth-input:focus{border-color:#00e5d4;box-shadow:0 0 0 3px rgba(0,229,212,.11)}
.ta-auth-hint,.ta-auth-optional{display:block;margin-top:7px;color:#8298ac;font-size:11px;font-weight:500;line-height:1.5}
.ta-auth-optional{display:inline;margin:0}
.ta-auth-submit{margin-top:10px;min-height:52px;background:linear-gradient(110deg,#00cdbf,#526dff);color:#03101a;box-shadow:0 10px 28px rgba(0,229,212,.16);letter-spacing:.03em}
.ta-auth-switch{display:block;margin:20px auto 0;color:#6ef5e9;font-weight:700;text-align:center}
.ta-auth-secure{margin-top:22px;padding-top:15px;border-top:1px solid rgba(117,157,187,.15);color:#70899e;text-align:center;font-size:11px}
@media(max-width:420px){.ta-auth-card{padding:22px 17px;border-radius:20px}.ta-auth-methods button{font-size:12px}}

@import url("https://fonts.googleapis.com/css2?family=Sora:wght@400;500;600;700;800&family=Manrope:wght@400;500;600;700;800&display=swap");
:root{color-scheme:dark}*{box-sizing:border-box}html,body,#root{margin:0;min-height:100%;width:100%}body{background:#02040b;color:#f5f7ff;font-family:Manrope,system-ui,sans-serif}button,input,select,textarea{font:inherit}button{border:0}a{color:inherit}h1,h2,h3,.brand,.eyebrow,.btn{font-family:Sora,Manrope,sans-serif}.app-shell{min-height:100vh;background:radial-gradient(900px 500px at 50% -5%,rgba(0,229,212,.18),transparent 60%),radial-gradient(700px 500px at 100% 35%,rgba(0,180,255,.12),transparent 65%),linear-gradient(180deg,#03050d,#010208 70%,#03050c);overflow-x:hidden}.navbar{position:sticky;top:0;z-index:100;min-height:74px;padding:9px 20px;display:flex;align-items:center;justify-content:space-between;gap:14px;background:rgba(3,5,12,.9);border-bottom:1px solid rgba(0,229,212,.35);backdrop-filter:blur(18px);box-shadow:0 0 35px rgba(0,229,212,.08)}.brand{display:flex;align-items:center;gap:11px;text-decoration:none;font-weight:900;font-size:22px;letter-spacing:.02em}.brand-mark{width:48px;height:48px;border-radius:14px;display:block;background:linear-gradient(145deg,#00e5d4,#ff7a00 55%,#6d19ff);border:1px solid rgba(255,255,255,.22);box-shadow:0 0 24px rgba(0,229,212,.42);position:relative}.brand-mark:before{content:'';position:absolute;inset:0;display:grid;place-items:center;font-size:27px;transform:rotate(-25deg)}.nav-links{display:flex;gap:5px;align-items:center}.nav-links a,.nav-dashboard{padding:9px 11px;border-radius:10px;text-decoration:none;color:#aeb6cb;font-weight:700;font-size:12px}.nav-links a.active,.nav-links a:hover{color:#fff;background:linear-gradient(90deg,rgba(0,229,212,.3),rgba(104,34,255,.22));box-shadow:inset 0 0 0 1px rgba(0,229,212,.25)}.menu-btn{display:none;width:45px;height:45px;border-radius:13px;background:#0b0e18;color:#fff;border:1px solid #242a3c}.page-section{max-width:1280px;margin:0 auto;padding:28px 20px 70px}.section-heading{margin-bottom:18px}.eyebrow{display:inline-block;color:#52f4e6;font-size:11px;font-weight:900;letter-spacing:.16em}.section-heading h1{font-size:32px;margin:7px 0}.section-heading p,.muted{color:#8f99ae}.dashboard-card,.rh-rocket-card,.game-panel,.deposit-card,.withdraw-card{background:linear-gradient(145deg,rgba(10,14,27,.96),rgba(3,6,14,.96));border:1px solid rgba(87,105,145,.35);border-radius:20px;box-shadow:0 18px 55px rgba(0,0,0,.4),inset 0 0 30px rgba(0,110,255,.025)}.dashboard-card{padding:20px;margin-top:16px}.rh-rocket-card{position:relative;overflow:hidden;border-color:rgba(255,32,83,.7);box-shadow:0 0 0 1px rgba(255,32,83,.12),0 0 45px rgba(0,229,212,.12)}.rh-rocket-status{position:absolute;z-index:8;left:18px;top:15px;color:#fff;background:#00bfb2;border-radius:8px;padding:7px 11px;font-weight:900;font-size:12px}.ta-space-scene{height:430px;position:relative;overflow:hidden;background:radial-gradient(circle at 70% 25%,rgba(45,98,255,.22),transparent 22%),radial-gradient(circle at 50% 90%,rgba(0,217,255,.16),transparent 30%),linear-gradient(145deg,#030817,#02030a 55%,#09030d)}.ta-space-scene:before{content:'';position:absolute;inset:0;background-image:radial-gradient(#fff 1px,transparent 1px);background-size:46px 46px;opacity:.16}.ta-space-scene:after{content:'';position:absolute;left:-10%;bottom:-50%;width:120%;height:85%;border-radius:50% 50% 0 0;background:radial-gradient(ellipse at 50% 0,#1bd8ff 0,#063b72 18%,#06162f 48%,#02040a 72%);box-shadow:0 -12px 50px rgba(0,205,255,.32)}.ta-moon{position:absolute;right:9%;top:14%;font-size:70px;opacity:.8;filter:drop-shadow(0 0 22px #78aaff)}.ta-cloud{position:absolute;color:#fff;opacity:.08;font-size:75px;z-index:2}.ta-cloud-a{left:8%;bottom:25%}.ta-cloud-b{right:25%;bottom:32%}.ta-earth-glow{position:absolute;left:35%;bottom:2%;width:30%;height:90px;background:radial-gradient(ellipse,#00eaff,transparent 68%);filter:blur(15px);z-index:1}.ta-earth{display:none}.ta-rocket-trail{position:absolute;left:17%;bottom:18%;width:66%;height:3px;background:linear-gradient(90deg,transparent,#00e5d4,#ff9d00,transparent);transform:rotate(-25deg);filter:blur(2px);box-shadow:0 0 20px #00e5d4;z-index:4}.ta-rocket{position:absolute;left:49%;bottom:17%;z-index:6;transition:transform .08s linear;transform-origin:center}.ta-rocket-body{width:56px;height:105px;border-radius:50% 50% 38% 38%;background:linear-gradient(90deg,#e8f3ff,#fff 45%,#28d9cf 46%,#8c092e);border:2px solid #fff;box-shadow:0 0 25px rgba(255,60,100,.9);position:relative}.ta-rocket-body:before{content:'';position:absolute;left:10px;top:20px;width:16px;height:16px;border-radius:50%;background:#37d9ff;border:3px solid #123b7c}.ta-rocket-body b{position:absolute;bottom:18px;left:15px;font-size:12px;color:#00e5d4}.ta-window{position:absolute}.ta-fin{position:absolute;bottom:9px;width:28px;height:32px;background:#00e5d4;z-index:-1}.ta-fin-left{left:-18px;clip-path:polygon(100% 0,100% 100%,0 100%)}.ta-fin-right{right:-18px;clip-path:polygon(0 0,100% 100%,0 100%)}.ta-flame{position:absolute;left:8px;bottom:-47px;width:40px;height:58px;background:linear-gradient(#fff,#ffca28 35%,#ff3b00 70%,transparent);clip-path:polygon(50% 100%,0 35%,25% 0,50% 35%,72% 0,100% 35%);filter:drop-shadow(0 0 14px #ff3b00);animation:flame .16s infinite alternate}.ta-altitude{position:absolute;right:18px;bottom:16px;color:#8e9ab4;font-size:11px;z-index:7}.rh-rocket-multiplier{position:absolute;left:0;right:0;top:46%;text-align:center;font:900 76px/1 Sora,sans-serif;color:#fff;text-shadow:0 0 12px #00e5d4,0 0 34px #00e5d4,0 0 65px rgba(0,229,212,.7);z-index:7}.rh-rocket-multiplier span{font-size:.58em}.rh-rocket-height{position:absolute;left:0;right:0;top:66%;text-align:center;color:#dce3f3;letter-spacing:.08em;font-weight:900;z-index:7}.rh-earnings-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}.rh-earning-box{padding:17px;border-radius:15px;background:#070b16;border:1px solid #202a40}.rh-earning-box span,.rh-earning-box small{display:block;color:#8994aa}.rh-earning-box strong{display:block;font:800 26px Sora,sans-serif;margin:8px 0}.ta-space-scene{border-bottom:1px solid rgba(0,229,212,.45)}.ta-space-scene:global{} .game-layout{display:grid;grid-template-columns:minmax(0,1fr) 315px;gap:14px;margin-top:14px}.game-controls{display:grid;grid-template-columns:1.3fr 1fr 1fr 1.25fr;gap:9px;padding:12px;border:1px solid #193c68;background:#050b17}.control-box{padding:13px;border:1px solid #1b426e;border-radius:12px;background:#050b16}.control-box span{display:block;color:#7f8ba4;font-size:11px}.control-box strong{display:block;font-size:21px;margin-top:5px}.token-input{width:100%;margin-top:7px;background:#020712;border:1px solid #1765a2;border-radius:9px;color:#fff;padding:10px;outline:none}.btn{cursor:pointer;border-radius:11px;padding:12px 16px;font-weight:900}.btn.primary,.cash-in{background:linear-gradient(90deg,#00e5d4,#5b7cff);color:#fff;box-shadow:0 0 22px rgba(0,229,212,.22)}.cash-out{background:linear-gradient(90deg,#00c853,#00a86b);color:#fff;box-shadow:0 0 22px rgba(0,220,120,.18)}.btn.full{width:100%}.player-panel{padding:13px;border:1px solid rgba(0,229,212,.7);border-radius:16px;background:linear-gradient(180deg,#090c18,#03050c)}.player-panel h3{margin:0 0 9px;font-size:14px}.live-dot{color:#00e676}.player-row{display:grid;grid-template-columns:1fr auto;gap:6px;padding:9px 4px;border-bottom:1px solid #182035}.player-name{font-weight:800;font-size:12px}.player-tokens{color:#00d9ff;font-size:11px}.player-state{font-size:10px;padding:4px 7px;border-radius:7px;background:#111a2c;color:#aeb9d0}.player-state.live{color:#00ff93;background:rgba(0,255,147,.1)}.player-state.lost{color:#ff547c;background:rgba(0,229,212,.1)}.demo-badge{font-size:8px;color:#ffb300;border:1px solid #805b00;border-radius:5px;padding:2px 4px;margin-left:4px}.finance-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:14px}.deposit-card,.withdraw-card{padding:18px}.finance-title{display:flex;align-items:center;gap:9px}.finance-title h2{margin:0;font-size:20px}.field{margin-top:11px}.field label{display:block;color:#aeb7c9;font-size:11px;margin-bottom:5px}.field input,.field select,.field textarea{width:100%;padding:12px;border-radius:10px;background:#030712;color:#fff;border:1px solid #1c4168;outline:none}.notice,.error,.success{padding:12px 14px;border-radius:11px;margin-top:12px}.notice{background:#071321;border:1px solid #123b63;color:#a8b8d0}.error{background:#250914;border:1px solid #8e183a;color:#ff9db4}.success{background:#062117;border:1px solid #126a43;color:#7dffbd}.footer{border-top:1px solid #1b2438;padding:24px 20px;color:#707b91;text-align:center}.table-wrap{overflow:auto}.steps,.feature-grid{display:grid;gap:12px}.feature-grid{grid-template-columns:repeat(3,1fr)}.feature,.step{background:#070b15;border:1px solid #1c2941;border-radius:14px;padding:16px}.btn.secondary{background:#101729;color:#d9e2f2;border:1px solid #263553}.text-btn{background:none;color:#70f7ee;cursor:pointer}.nav-links.open{display:flex}@keyframes flame{to{transform:scaleY(1.16) scaleX(.92)}}@media(max-width:900px){.game-layout,.finance-grid{grid-template-columns:1fr}.rh-earnings-grid{grid-template-columns:repeat(2,1fr)}.feature-grid{grid-template-columns:1fr 1fr}.nav-links{display:none;position:absolute;left:10px;right:10px;top:67px;padding:10px;background:#070a13;border:1px solid #252e43;border-radius:14px;flex-direction:column;align-items:stretch}.menu-btn{display:flex}.navbar{padding:8px 12px}.page-section{padding:20px 12px 60px}}@media(max-width:560px){.brand{font-size:18px}.brand-mark{width:43px;height:43px}.rh-rocket-multiplier{font-size:55px}.ta-space-scene{height:350px}.game-controls{grid-template-columns:1fr 1fr}.rh-earnings-grid,.feature-grid{grid-template-columns:1fr}.section-heading h1{font-size:24px}} .ta-service-modal{position:fixed;inset:0;z-index:250;background:rgba(0,0,0,.72);backdrop-filter:blur(10px);padding:20px;overflow:auto}.ta-service-panel{max-width:720px;margin:30px auto;padding:22px;border-color:rgba(0,229,212,.55);box-shadow:0 25px 90px rgba(0,0,0,.65),0 0 45px rgba(0,229,212,.12)}.service-head{display:flex;align-items:flex-start;justify-content:space-between;gap:15px;margin-bottom:18px}.service-head h2{margin:5px 0}.ta-actions-card{border-color:rgba(0,217,255,.25);margin:18px 0}.ta-actions-card .hero-actions{margin-top:16px}.ta-actions-card .btn{min-width:170px}@media(max-width:650px){.ta-service-modal{padding:10px}.ta-service-panel{margin:10px auto;padding:15px}.ta-actions-card .hero-actions{display:grid;grid-template-columns:1fr 1fr}.ta-actions-card .btn{min-width:0}}
.admin-section-bar{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px;margin:16px 0 18px}.admin-section-tile{display:flex;flex-direction:column;align-items:flex-start;gap:7px;min-height:108px;padding:15px;border-radius:16px;text-decoration:none;background:linear-gradient(145deg,rgba(12,16,31,.98),rgba(5,8,18,.98));border:1px solid rgba(255,37,93,.42);box-shadow:0 10px 28px rgba(0,0,0,.3),inset 0 0 22px rgba(104,34,255,.06);color:#f5f7ff;transition:.18s transform,.18s border-color,.18s box-shadow}.admin-section-tile:hover{transform:translateY(-2px);border-color:rgba(0,216,255,.75);box-shadow:0 0 26px rgba(0,229,212,.15),inset 0 0 25px rgba(0,190,255,.05)}.admin-section-tile svg{color:#00d9ff;filter:drop-shadow(0 0 8px rgba(0,217,255,.5))}.admin-section-tile span{font:800 13px Sora,Manrope,sans-serif}.admin-section-tile small{font-size:10px;line-height:1.35;color:#8995ad}.rh-admin-section{margin:18px 0;border-radius:20px;overflow:hidden;background:linear-gradient(145deg,rgba(10,14,28,.98),rgba(3,6,14,.98));border:1px solid rgba(255,32,83,.34);box-shadow:0 18px 50px rgba(0,0,0,.35),inset 0 0 35px rgba(89,32,255,.045);scroll-margin-top:92px}.rh-admin-section-head{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:20px;background:linear-gradient(90deg,rgba(0,229,212,.09),rgba(74,39,255,.07),rgba(0,205,255,.04));border-bottom:1px solid rgba(67,84,125,.35)}.rh-admin-section-head h2{margin:5px 0;font-size:22px}.rh-admin-section-head p{margin:0;color:#8f99ae;font-size:12px;line-height:1.5}.rh-admin-section-body{padding:18px}.rh-admin-count{padding:7px 10px;border-radius:999px;background:rgba(0,217,255,.08);border:1px solid rgba(0,217,255,.3);color:#6feaff;font-size:11px;font-weight:900;white-space:nowrap}.rh-customer-row,.admin-list-item,.admin-plan{background:linear-gradient(145deg,#080d1b,#050811);border:1px solid #1b2a45;box-shadow:inset 0 0 22px rgba(0,229,212,.025)}.rh-customer-row{border-radius:15px;padding:15px;margin-top:10px}.rh-customer-row:hover,.admin-list-item:hover,.admin-plan:hover{border-color:rgba(255,43,98,.5)}.rh-small-avatar{background:linear-gradient(145deg,#00e5d4,#6d19ff);box-shadow:0 0 18px rgba(0,229,212,.2)}.rh-admin-title{font-family:Sora,Manrope,sans-serif}.rh-setting-card{background:linear-gradient(145deg,#090e1c,#040711);border:1px solid #243653;border-radius:16px;padding:18px;box-shadow:inset 0 0 24px rgba(0,210,255,.025)}.rh-search{display:flex;align-items:center;gap:8px;padding:10px 12px;border-radius:11px;background:#030712;border:1px solid #1b4168;color:#71809a;margin-bottom:12px}.rh-search input{flex:1;background:none;border:0;outline:0;color:#fff}.rh-empty{padding:22px;border-radius:13px;background:#050a15;border:1px dashed #263653;color:#8f99ae;text-align:center}.ta-admin-credit{margin-top:12px;padding:13px;border:1px solid rgba(0,217,255,.25);border-radius:12px;background:rgba(0,100,180,.045)}.admin-plan{padding:17px;border-radius:16px;margin-top:12px}.plan-heading{display:flex;align-items:center;justify-content:space-between;gap:12px}.admin-plan label{display:block;margin-top:10px;color:#aeb7c9;font-size:11px}.admin-plan input,.admin-plan textarea{width:100%;margin-top:5px;padding:11px;border-radius:10px;background:#030712;color:#fff;border:1px solid #1c4168;outline:none}.hero-actions{display:flex;flex-wrap:wrap;gap:9px;margin-top:14px}.rh-slip{margin-top:12px;padding:12px;border-radius:13px;background:#030712;border:1px solid #1c2c46}.rh-slip img{display:block;max-width:100%;max-height:360px;object-fit:contain;margin:auto;border-radius:9px}.rh-slip-link{display:inline-flex;align-items:center;gap:6px;margin-top:9px;color:#62eaff;text-decoration:none;font-size:12px}.rh-warning{margin-top:12px;padding:12px;border-radius:11px;background:#211708;border:1px solid #6b4a12;color:#ffd27a;font-size:12px}.checkbox-row{display:flex!important;align-items:center;gap:7px}.checkbox-row input{width:auto!important;margin:0!important}@media(max-width:1050px){.admin-section-bar{grid-template-columns:repeat(3,1fr)}}@media(max-width:650px){.admin-section-bar{grid-template-columns:1fr 1fr}.rh-admin-section-head{align-items:flex-start;flex-direction:column}.rh-admin-section-body{padding:12px}.rh-customer-row{padding:12px}.rh-customer-actions{margin-top:10px}}

/* TA777Gaming cinematic mobile rocket overrides */
.rocket-launch-video{perspective:900px;isolation:isolate}
.rocket-launch-video .launch-grid{position:absolute;left:-25%;right:-25%;bottom:0;height:58%;opacity:.18;background:linear-gradient(rgba(0,210,255,.35) 1px,transparent 1px),linear-gradient(90deg,rgba(0,210,255,.25) 1px,transparent 1px);background-size:42px 42px;transform:perspective(260px) rotateX(62deg) scale(1.35);transform-origin:bottom;z-index:2;animation:gridMove 1.8s linear infinite}
.rocket-launch-video .launch-horizon{position:absolute;left:0;right:0;bottom:20%;height:2px;background:linear-gradient(90deg,transparent,#00eaff,#00e5d4,#00eaff,transparent);box-shadow:0 0 30px #00eaff,0 0 55px rgba(0,229,212,.65);z-index:3;animation:horizonPulse .8s ease-in-out infinite alternate}
.ta-rocket{filter:drop-shadow(0 0 12px rgba(255,70,100,.85)) drop-shadow(0 16px 22px rgba(0,0,0,.55));transform-style:preserve-3d}
.ta-rocket-body{transform:rotateY(-12deg) rotateX(4deg);background:linear-gradient(105deg,#69778f 0%,#f8fbff 18%,#ffffff 43%,#28d9cf 45%,#9a082f 68%,#2a0a19 100%);box-shadow:inset -9px 0 13px rgba(0,0,0,.35),inset 7px 0 8px rgba(255,255,255,.55),0 0 28px rgba(255,50,95,.9)}
.rocket-nose{position:absolute;left:3px;top:-27px;width:46px;height:39px;border-radius:50% 50% 35% 35%;background:linear-gradient(110deg,#b9c7d8,#fff 35%,#ff2b58 65%,#7d0a2d);border:2px solid rgba(255,255,255,.9);transform:rotateX(12deg);box-shadow:inset -7px 0 8px rgba(0,0,0,.25)}
.rocket-window{position:absolute;left:15px;top:16px;width:25px;height:25px;border-radius:50%;background:radial-gradient(circle at 35% 30%,#d8fbff 0 10%,#4be4ff 20%,#155c9e 62%,#061426 100%);border:3px solid #e8f5ff;box-shadow:0 0 12px #00d9ff,inset -4px -4px 7px rgba(0,0,0,.5)}
.rocket-window span{position:absolute;left:5px;top:4px;width:7px;height:4px;border-radius:50%;background:#fff;opacity:.85;transform:rotate(-25deg)}
.rocket-panel{position:absolute;right:7px;top:47px;display:flex;flex-direction:column;gap:4px}.rocket-panel i{display:block;width:7px;height:3px;border-radius:3px;background:#00eaff;box-shadow:0 0 6px #00eaff}.rocket-panel i:nth-child(2){background:#ffcc33;box-shadow:0 0 6px #ffcc33}.rocket-panel i:nth-child(3){background:#00e5d4;box-shadow:0 0 6px #00e5d4}
.ta-flame{height:78px;bottom:-63px;width:44px;animation:flame .09s infinite alternate,flameStretch .55s ease-in-out infinite}
.ta-rocket-trail{height:7px;filter:blur(3px);animation:trailPulse .25s ease-in-out infinite alternate}
.rh-rocket-multiplier{font-size:clamp(52px,9vw,78px);letter-spacing:-.04em}
@keyframes gridMove{from{background-position:0 0,0 0}to{background-position:0 42px,42px 0}}
@keyframes horizonPulse{from{opacity:.5;transform:scaleX(.86)}to{opacity:1;transform:scaleX(1.08)}}
@keyframes trailPulse{from{opacity:.6;transform:rotate(-25deg) scaleX(.9)}to{opacity:1;transform:rotate(-25deg) scaleX(1.12)}}
@keyframes flameStretch{from{transform:scaleY(.9) scaleX(.88)}to{transform:scaleY(1.28) scaleX(1.02)}}
.ta-service-panel{width:min(100%,620px);max-height:88vh;overflow:auto}
.ta-actions-card .hero-actions{display:grid;grid-template-columns:1fr 1fr;gap:10px}
@media(max-width:650px){.navbar{min-height:60px}.page-section{padding:14px 10px 45px}.section-heading h1{font-size:24px}.section-heading p{font-size:13px}.ta-space-scene{height:390px;border-radius:14px}.rh-rocket-card{border-radius:16px}.rh-rocket-multiplier{top:43%;font-size:54px}.rh-rocket-height{top:61%;font-size:9px}.ta-rocket-body{width:48px;height:92px}.rocket-nose{width:40px;height:34px;left:2px;top:-23px}.rocket-window{left:12px;top:14px;width:23px;height:23px}.ta-flame{bottom:-58px;height:70px;width:39px}.game-controls{grid-template-columns:1fr 1fr;gap:7px}.control-box{padding:10px}.control-box strong{font-size:17px}.token-input{padding:9px}.player-panel{max-height:330px;overflow:auto}.ta-actions-card .hero-actions{grid-template-columns:1fr}.ta-service-modal{padding:8px}.ta-service-panel{border-radius:16px;padding:14px}.service-head{gap:8px}.service-head h2{font-size:20px}.finance-grid{grid-template-columns:1fr}.feature-grid{grid-template-columns:1fr}.rh-earnings-grid{grid-template-columns:1fr 1fr}}
/* TA777Gaming graph-style rocket market UI */
body{font-family:Manrope,Manrope,system-ui,sans-serif;letter-spacing:.01em}h1,h2,h3,.brand,.eyebrow,.btn,.rh-rocket-status,.control-box span,.rocket-chart-topline,.rocket-metric-strip{font-family:Sora,Manrope,sans-serif}.brand-mark:before{content:'TA';font-family:Sora,sans-serif;font-size:13px;font-weight:900;color:#fff;transform:none;text-shadow:0 0 10px rgba(0,229,255,.9)}.brand-mark{background:linear-gradient(145deg,#071525,#0a2c45 52%,#6d1236);border-color:rgba(0,229,255,.45);box-shadow:0 0 24px rgba(0,229,255,.2),inset 0 0 18px rgba(0,229,212,.16)}
.rocket-chart-card{background:linear-gradient(145deg,#040914,#02040a 68%,#08040b);border-color:rgba(0,229,255,.28);box-shadow:0 20px 70px rgba(0,0,0,.55),inset 0 0 45px rgba(0,229,255,.035)}.rocket-chart-topline{height:74px;padding:14px 18px;display:grid;grid-template-columns:1fr auto auto;align-items:center;gap:16px;border-bottom:1px solid rgba(75,101,145,.22);background:linear-gradient(90deg,rgba(0,229,255,.055),rgba(0,229,212,.045))}.rocket-chart-topline span{font-size:11px;letter-spacing:.18em;color:#71839f}.rocket-chart-topline strong{font-size:30px;color:#fff;text-shadow:0 0 18px rgba(0,229,255,.55)}.rocket-chart-topline small{font-size:9px;color:#00e5ff;letter-spacing:.14em}.rocket-chart{height:390px;position:relative;background:radial-gradient(circle at 80% 12%,rgba(0,229,255,.08),transparent 26%),linear-gradient(180deg,#030813,#02040a);overflow:hidden}.chart-y-labels{position:absolute;left:8px;top:25px;bottom:31px;z-index:3;display:flex;flex-direction:column;justify-content:space-between;color:#596983;font:700 9px/1 Sora,sans-serif}.rocket-graph{position:absolute;inset:0;width:100%;height:100%}.chart-grid-lines line{stroke:rgba(100,130,170,.14);stroke-width:1;stroke-dasharray:4 8}.graph-base{fill:none;stroke:rgba(90,110,145,.25);stroke-width:2;stroke-dasharray:7 8}.graph-fill{fill:url(#taGraphFill);stroke:none;opacity:.8}.graph-live-line{fill:none;stroke:#00e5ff;stroke-width:4;filter:drop-shadow(0 0 7px rgba(0,229,255,.8));stroke-linecap:round;stroke-linejoin:round}.graph-point{fill:#fff;stroke:#00e5ff;stroke-width:3}.graph-point-glow{fill:rgba(0,229,255,.3);stroke:rgba(0,229,255,.25);stroke-width:2}.graph-rocket{fill:#f7fbff;stroke:#28d9cf;stroke-width:2;filter:drop-shadow(0 0 8px rgba(255,49,95,.9))}.graph-rocket circle{fill:#00e5ff;stroke:#fff;stroke-width:1}.graph-rocket path:last-child{fill:#ff7a00;stroke:#28d9cf;stroke-width:1}.graph-axis-label{position:absolute;right:16px;bottom:12px;color:#52617a;font:700 8px Sora,sans-serif;letter-spacing:.14em}.graph-status-chip{position:absolute;left:18px;bottom:12px;color:#00e5ff;font:800 9px Sora,sans-serif;letter-spacing:.12em}.rocket-metric-strip{display:grid;grid-template-columns:repeat(3,1fr);border-top:1px solid rgba(70,93,130,.28);background:#030711}.rocket-metric-strip>div{padding:12px 15px;border-right:1px solid rgba(70,93,130,.2)}.rocket-metric-strip>div:last-child{border-right:0}.rocket-metric-strip span{display:block;color:#667590;font-size:8px;letter-spacing:.14em}.rocket-metric-strip strong{display:block;margin-top:5px;color:#eaf7ff;font-size:13px}.ta-space-scene{display:none!important}@media(max-width:650px){.rocket-chart-topline{height:66px;padding:11px 12px;grid-template-columns:1fr auto;gap:5px}.rocket-chart-topline strong{font-size:24px}.rocket-chart-topline small{grid-column:1/-1;font-size:7px}.rocket-chart{height:330px}.chart-y-labels{font-size:7px;top:22px;bottom:28px}.rocket-metric-strip>div{padding:10px 8px}.rocket-metric-strip strong{font-size:11px}.graph-status-chip,.graph-axis-label{font-size:7px}.brand-mark{width:42px;height:42px}}


/* TA777 cinematic rocket launch redesign */
body{font-family:'Manrope',system-ui,sans-serif}h1,h2,h3,.brand,.eyebrow,.btn,.rocket-hud strong,.rocket-bottom-hud strong{font-family:'Sora','Manrope',sans-serif}.cinematic-rocket-card{border-color:rgba(43,112,255,.45)!important;background:#01050c!important;box-shadow:0 0 0 1px rgba(0,153,255,.08),0 20px 70px rgba(0,0,0,.6)!important}.rocket-live-chip{position:absolute;left:16px;top:14px;z-index:20;background:rgba(4,11,22,.86);border:1px solid rgba(0,205,255,.4);color:#bfeeff;border-radius:6px;padding:7px 10px;font:700 10px Manrope,sans-serif;letter-spacing:.12em}.rocket-hud{position:absolute;right:14px;top:12px;z-index:20;display:flex;gap:8px}.rocket-hud>div{min-width:92px;padding:8px 10px;background:rgba(3,8,17,.72);border:1px solid rgba(96,128,180,.25);border-radius:7px;text-align:right;backdrop-filter:blur(8px)}.rocket-hud span{display:block;color:#6e7f9b;font-size:8px;letter-spacing:.12em}.rocket-hud strong{display:block;margin-top:2px;color:#fff;font-size:19px}.rocket-launch-scene{height:520px;position:relative;overflow:hidden;background:#03070e;isolation:isolate}.sky-layer{position:absolute;inset:0;transition:opacity .4s linear}.sky-day{background:linear-gradient(180deg,#142c58 0%,#1b416e 34%,#254e70 58%,#172536 76%,#060b12 100%)}.sky-night{background:linear-gradient(180deg,#000208 0%,#01040a 40%,#020713 72%,#03050a 100%)}.stars{position:absolute;inset:0;z-index:3;background-image:radial-gradient(circle,rgba(255,255,255,.92) 0 1px,transparent 1.5px),radial-gradient(circle,rgba(150,211,255,.72) 0 1px,transparent 1.5px);background-size:73px 61px,113px 97px;background-position:9px 17px,41px 7px;animation:starsDrift 22s linear infinite}.stars-b{background-size:157px 123px,91px 109px;background-position:22px 8px,66px 49px;animation-duration:31s}.stars-c{background-size:211px 173px,181px 151px;background-position:7px 71px,99px 31px;animation-duration:42s}.distant-haze{position:absolute;left:-15%;right:-15%;bottom:18%;height:32%;z-index:5;background:radial-gradient(ellipse at 50% 100%,rgba(119,190,255,.24),transparent 63%);filter:blur(12px)}.earth-horizon{position:absolute;z-index:6;left:-16%;right:-16%;bottom:-47%;height:70%;border-radius:50% 50% 0 0;background:radial-gradient(ellipse at 50% 0,#1f8ab6 0%,#0b385b 13%,#06172d 34%,#020711 62%,#000 78%);box-shadow:0 -4px 30px rgba(0,205,255,.42),0 -16px 90px rgba(0,115,255,.22)}.earth-horizon:after{content:'';position:absolute;inset:10% 4% 0;border-radius:50%;background:repeating-linear-gradient(163deg,transparent 0 19px,rgba(61,174,105,.08) 20px 23px,transparent 24px 46px);filter:blur(7px);opacity:.8}.earth-glow{position:absolute;z-index:5;left:18%;right:18%;bottom:18%;height:80px;background:radial-gradient(ellipse,rgba(0,221,255,.75),transparent 68%);filter:blur(20px)}.launch-pad{position:absolute;z-index:8;left:50%;bottom:10%;width:170px;height:9px;transform:translateX(-50%);border-radius:50%;background:linear-gradient(90deg,transparent,#4bcfff,#fff,#4bcfff,transparent);box-shadow:0 0 25px rgba(0,220,255,.65)}.launch-pad:before{content:'';position:absolute;left:22%;right:22%;top:7px;height:45px;background:linear-gradient(90deg,transparent,rgba(20,105,155,.32),transparent);clip-path:polygon(42% 0,58% 0,100% 100%,0 100%);opacity:.7}.launch-smoke{position:absolute;z-index:7;left:50%;bottom:6%;width:220px;height:100px;transform:translateX(-50%);background:radial-gradient(ellipse,rgba(215,239,255,.32),transparent 65%);filter:blur(13px)}.rocket-flight-path{position:absolute;z-index:4;left:18%;bottom:20%;width:64%;height:64%;border-left:1px solid rgba(100,180,255,.08);border-top:1px solid rgba(100,180,255,.05);border-radius:100% 0 0 0;transform:rotate(-24deg);filter:blur(.2px)}.cinematic-rocket{position:absolute;z-index:15;width:70px;height:155px;pointer-events:none}.rocket-body-premium{position:absolute;left:10px;top:12px;width:50px;height:98px;border-radius:50% 50% 36% 36%;background:linear-gradient(90deg,#9ca8ba 0%,#f4f8ff 20%,#fff 43%,#cbd5e1 59%,#8d99aa 100%);border:1px solid rgba(255,255,255,.9);box-shadow:inset -7px 0 12px rgba(20,33,53,.42),inset 7px 0 10px rgba(255,255,255,.42),0 0 25px rgba(0,210,255,.42)}.rocket-nose-premium{position:absolute;left:-1px;top:-22px;width:50px;height:42px;background:linear-gradient(90deg,#737f92,#eef4fa 38%,#fff 55%,#6f7c8d);clip-path:polygon(50% 0,100% 100%,0 100%);border-radius:50% 50% 12% 12%}.rocket-window-premium{position:absolute;left:12px;top:22px;width:27px;height:27px;border-radius:50%;background:radial-gradient(circle at 34% 30%,#bff7ff 0 8%,#21bce5 10% 35%,#073d6a 62%,#020b17 100%);border:2px solid #d8fbff;box-shadow:0 0 11px rgba(50,218,255,.75)}.rocket-window-premium span{position:absolute;left:5px;top:4px;width:7px;height:4px;border-radius:50%;background:#fff;opacity:.8;transform:rotate(-28deg)}.rocket-band-premium{position:absolute;left:0;right:0;top:57px;height:7px;background:linear-gradient(90deg,#0e6b9d,#18d5ff,#0b517c);box-shadow:0 0 10px rgba(0,210,255,.35)}.rocket-fin-premium{position:absolute;bottom:8px;width:23px;height:36px;background:linear-gradient(160deg,#8e102e,#28d9cf 45%,#6e061f);z-index:-1}.rocket-fin-left{left:-18px;clip-path:polygon(100% 0,100% 100%,0 100%,20% 45%)}.rocket-fin-right{right:-18px;clip-path:polygon(0 0,100% 45%,100% 100%,0 100%)}.rocket-body-premium b{position:absolute;left:18px;bottom:18px;color:#111827;font:900 10px Sora,sans-serif}.rocket-engine{position:absolute;left:10px;bottom:-4px;width:30px;height:14px;border-radius:0 0 50% 50%;background:#172333;box-shadow:0 2px 7px #000}.rocket-flame{position:absolute;left:12px;bottom:-57px;width:27px;height:62px;clip-path:polygon(50% 100%,0 30%,23% 0,50% 28%,74% 0,100% 30%);transform-origin:50% 0;background:linear-gradient(#fff 0 14%,#ffe46b 26%,#ff8a00 53%,#ff2a00 75%,transparent 100%);filter:drop-shadow(0 0 13px #ff6400);animation:rocketFlame .11s infinite alternate}.flame-two{left:18px;width:17px;height:45px;opacity:.78;animation-delay:.04s}.rocket-trail-premium{position:absolute;left:31px;top:116px;width:9px;transform:translateX(-50%);background:linear-gradient(180deg,rgba(255,245,210,.95),rgba(255,106,0,.68),rgba(255,35,0,.15),transparent);filter:blur(5px);border-radius:50%;opacity:.8}.altitude-readout{position:absolute;z-index:20;right:14px;bottom:14px;color:#7f91ab;font:700 9px Manrope,sans-serif;letter-spacing:.14em;background:rgba(0,5,12,.62);border:1px solid rgba(90,122,160,.22);padding:7px 9px;border-radius:6px}.altitude-readout strong{color:#d8f8ff;font-size:12px}.rocket-state{position:absolute;z-index:20;left:50%;top:50%;transform:translate(-50%,-50%);color:rgba(255,255,255,.75);font:800 9px Manrope,sans-serif;letter-spacing:.24em;text-shadow:0 0 12px rgba(0,220,255,.8)}.rocket-bottom-hud{display:grid;grid-template-columns:repeat(3,1fr);background:#030811;border-top:1px solid rgba(76,101,135,.3)}.rocket-bottom-hud>div{padding:11px 14px;border-right:1px solid rgba(76,101,135,.2)}.rocket-bottom-hud>div:last-child{border-right:0}.rocket-bottom-hud span{display:block;color:#66758c;font-size:8px;letter-spacing:.14em}.rocket-bottom-hud strong{display:block;margin-top:4px;font-size:12px;color:#eaf8ff}.rocket-bottom-hud>div:last-child strong{color:#00ff9d}@keyframes rocketFlame{to{transform:scaleY(1.14) scaleX(.9);filter:drop-shadow(0 0 19px #ff4b00)}}@keyframes starsDrift{from{transform:translateY(0)}to{transform:translateY(16px)}}

/* =========================================================
   MOONSHOT-STYLE ROCKET LAUNCH — visual replacement only
   The website remains TA777Gaming. No game logic or database flow changes.
========================================================= */
.moonshot-moon{position:absolute;z-index:4;right:10%;top:12%;width:74px;height:74px;border-radius:50%;background:radial-gradient(circle at 32% 28%,#fff 0 6%,#dcecff 9%,#9eb4cf 42%,#52677f 68%,#182537 100%);box-shadow:0 0 28px rgba(180,220,255,.28),0 0 80px rgba(70,140,255,.12);transition:opacity .5s linear,transform .4s linear}.moonshot-moon:before,.moonshot-moon:after{content:'';position:absolute;border-radius:50%;background:rgba(36,54,76,.28);filter:blur(1px)}.moonshot-moon:before{width:12px;height:12px;left:18px;top:24px}.moonshot-moon:after{width:8px;height:8px;right:17px;top:16px}
.rocket-launch-scene{height:560px;background:#01050b;position:relative;overflow:hidden;isolation:isolate}
.sky-day{background:linear-gradient(180deg,#071c3a 0%,#0a3157 28%,#15557a 55%,#15394e 72%,#07111d 100%)}
.sky-night{background:linear-gradient(180deg,#000105 0%,#01030a 38%,#020711 72%,#03050a 100%)}
.stars{z-index:5;animation:starsDrift 26s linear infinite}
.distant-haze{z-index:6}
.earth-horizon{z-index:8;left:-22%;right:-22%;bottom:-55%;height:78%;background:radial-gradient(ellipse at 50% 0,#35a7cf 0%,#0d4b70 10%,#062641 28%,#02101f 52%,#000 74%);box-shadow:0 -5px 35px rgba(0,210,255,.48),0 -22px 110px rgba(0,105,255,.22)}
.earth-horizon:after{opacity:.9}
.earth-glow{z-index:7;bottom:20%;height:110px;background:radial-gradient(ellipse,rgba(0,229,255,.82),transparent 66%);filter:blur(24px)}
.launch-pad{z-index:11;bottom:9%;width:190px;height:8px;box-shadow:0 0 28px rgba(0,220,255,.75)}
.launch-smoke{z-index:10;bottom:5%;width:260px;height:130px}
.cinematic-rocket{z-index:18;width:76px;height:174px}
.rocket-body-premium{left:12px;top:16px;width:52px;height:108px;border-radius:52% 52% 40% 40%;box-shadow:inset -8px 0 13px rgba(20,33,53,.42),inset 8px 0 11px rgba(255,255,255,.5),0 0 32px rgba(0,210,255,.52)}
.rocket-nose-premium{left:-1px;top:-24px;width:52px;height:46px}
.rocket-window-premium{left:12px;top:24px;width:28px;height:28px}
.rocket-band-premium{top:62px;height:8px}
.rocket-engine{bottom:-5px}
.rocket-flame{bottom:-68px;height:74px;filter:drop-shadow(0 0 17px #ff6400)}
.rocket-trail-premium{left:38px;top:128px;width:12px;filter:blur(6px);opacity:.9}
.altitude-readout{z-index:22;right:16px;bottom:16px}
.rocket-state{z-index:22;top:18%;left:50%;font-family:'Sora','Manrope',sans-serif;letter-spacing:.2em;text-shadow:0 0 18px rgba(0,220,255,.85)}
.rocket-bottom-hud{position:relative;z-index:30}
@keyframes rocketFlame{to{transform:scaleY(1.2) scaleX(.88);filter:drop-shadow(0 0 23px #ff4b00)}}
@media(max-width:650px){.rocket-launch-scene{height:455px}.rocket-hud{top:11px;right:10px;gap:5px}.rocket-hud>div{min-width:76px;padding:6px 7px}.rocket-hud strong{font-size:15px}.rocket-live-chip{left:10px;top:11px;font-size:8px}.rocket-bottom-hud>div{padding:9px 8px}.rocket-bottom-hud strong{font-size:10px}.cinematic-rocket{transform:translate(-50%,50%) scale(.82)!important}.rocket-state{font-size:8px}.moonshot-moon{width:52px;height:52px;right:7%;top:17%}}

/* TA777Gaming blue-and-white Moonshot look, matching the approved concept */
.rocket-trajectory{position:absolute;inset:0;width:100%;height:100%;z-index:9;overflow:visible;pointer-events:none;filter:drop-shadow(0 0 9px rgba(35,191,255,.42))}
.rocket-trajectory path{fill:none;stroke:rgba(74,207,255,.72);stroke-width:3;stroke-linecap:round;stroke-dasharray:9 13}
:root{--ta-accent:#16dfff;--ta-violet:#6f8cff;--ta-panel:#071a35;--ta-line:rgba(27,202,255,.32)}
body{background:#020d22;color:#f4f9ff}
.app-shell{background:radial-gradient(900px 520px at 38% -6%,rgba(0,145,255,.20),transparent 62%),radial-gradient(700px 500px at 100% 20%,rgba(75,123,255,.17),transparent 65%),linear-gradient(180deg,#06142d,#020b1d 74%,#010817)}
.navbar{background:rgba(3,15,38,.94);border-bottom-color:rgba(24,199,255,.45);box-shadow:0 0 34px rgba(0,135,255,.12)}
.brand-mark{background:linear-gradient(145deg,#18e7ff,#437dff 65%,#b8f4ff);box-shadow:0 0 24px rgba(30,198,255,.38)}
.nav-links a.active,.nav-links a:hover{background:linear-gradient(90deg,rgba(0,195,255,.24),rgba(92,130,255,.22));box-shadow:inset 0 0 0 1px rgba(87,198,255,.28)}
.eyebrow{color:#72eaff}
.dashboard-card,.rh-rocket-card,.game-panel,.deposit-card,.withdraw-card{background:linear-gradient(145deg,rgba(7,27,58,.98),rgba(3,13,33,.98));border-color:rgba(72,153,232,.38);box-shadow:0 18px 55px rgba(0,0,0,.34),inset 0 0 30px rgba(30,132,255,.045)}
.rh-rocket-card.cinematic-rocket-card{border-color:rgba(34,171,255,.55)!important;background:#020b20!important;box-shadow:0 0 0 1px rgba(0,153,255,.1),0 20px 70px rgba(0,0,0,.5)!important}
.game-controls{border-color:#1b4a80;background:#061631}.control-box{border-color:#23528a;background:#061631}.token-input{background:#031027;border-color:#2879bd}
.btn.primary,.cash-in{background:linear-gradient(100deg,#17dfff,#5487ff);color:#04172b;box-shadow:0 0 22px rgba(0,190,255,.22)}
.player-panel{border-color:rgba(43,164,255,.55);background:linear-gradient(180deg,#071b3b,#031027)}
.ta-auth-card{border-color:rgba(53,174,255,.4);background:linear-gradient(150deg,rgba(8,30,65,.98),rgba(3,13,32,.98))}
.ta-auth-mark{background:linear-gradient(135deg,#19e4ff,#5686ff 75%);color:#06152c;box-shadow:0 0 30px rgba(25,180,255,.24)}
.ta-auth-submit{background:linear-gradient(110deg,#1bdcff,#638cff);color:#04152b;box-shadow:0 10px 28px rgba(0,153,255,.2)}
.ta-auth-input{background:#04132d;border-color:#28517d}.ta-auth-input:focus{border-color:#35dfff;box-shadow:0 0 0 3px rgba(53,200,255,.13)}
.rocket-launch-scene{background:#020b20}.sky-day{background:linear-gradient(180deg,#0a2860 0%,#0c4a86 35%,#1a7cb4 62%,#0b315b 82%,#030e25 100%)}
.earth-horizon{background:radial-gradient(ellipse at 50% 0,#75e7ff 0%,#176ba7 13%,#083762 34%,#03172f 62%,#010817 80%);box-shadow:0 -4px 34px rgba(63,208,255,.62),0 -16px 90px rgba(0,115,255,.28)}
.earth-glow{background:radial-gradient(ellipse,rgba(140,238,255,.9),transparent 68%)}
.rocket-body-premium{background:linear-gradient(90deg,#8ca9c7 0%,#edf8ff 23%,#fff 45%,#d8eaff 66%,#7d9ab9 100%);box-shadow:inset -7px 0 12px rgba(20,33,53,.28),inset 7px 0 10px rgba(255,255,255,.62),0 0 28px rgba(80,205,255,.55)}
.rocket-nose-premium{background:linear-gradient(90deg,#7f9bb8,#edf8ff 38%,#fff 55%,#7795b6)}
.rocket-band-premium{background:linear-gradient(90deg,#155c9a,#30dfff,#174d9b)}
.rocket-fin-premium{background:linear-gradient(160deg,#e7f7ff,#28cfff 55%,#547dff)}
.rocket-flame{background:linear-gradient(#fff 0 18%,#b9f6ff 32%,#32cfff 57%,#3478ff 77%,transparent 100%);filter:drop-shadow(0 0 15px #39bfff)}
.rocket-trail-premium{background:linear-gradient(180deg,rgba(255,255,255,.98),rgba(123,236,255,.75),rgba(48,141,255,.25),transparent);filter:blur(6px)}
.rocket-state{color:#e8f9ff;text-shadow:0 0 18px rgba(56,190,255,.9)}
.rocket-bottom-hud{background:#031027;border-top-color:rgba(78,153,230,.3)}
.rocket-bottom-hud>div{border-right-color:rgba(78,153,230,.22)}
.altitude-readout{display:none!important}

/* TA777Gaming jet runway takeoff scene */
.rocket-launch-scene{background:linear-gradient(180deg,#061b45 0%,#0b4b83 42%,#a6dff5 76%,#0a1e39 100%)}
.runway-horizon{position:absolute;z-index:7;left:-8%;right:-8%;bottom:12%;height:19%;background:linear-gradient(180deg,rgba(31,78,118,.05),rgba(2,12,30,.9));border-top:1px solid rgba(160,235,255,.45)}
.jet-runway{position:absolute;z-index:10;left:-8%;right:-8%;bottom:-9%;height:43%;background:linear-gradient(180deg,#152f4f 0%,#06182e 78%,#020a17 100%);clip-path:polygon(43% 0,57% 0,100% 100%,0 100%);border-top:2px solid rgba(130,227,255,.9);filter:drop-shadow(0 0 20px rgba(27,195,255,.5))}
.runway-centerline{position:absolute;left:49.3%;top:2%;width:1.4%;height:96%;background:repeating-linear-gradient(180deg,#eafaff 0 22px,transparent 22px 43px);opacity:.95;filter:drop-shadow(0 0 5px #42dfff)}
.runway-edge{position:absolute;top:0;bottom:0;width:2px;background:#54dfff;box-shadow:0 0 12px #25caff}.runway-edge-left{left:43%}.runway-edge-right{right:43%}
.runway-lights{position:absolute;inset:0;background:radial-gradient(circle at 46% 12%,#fff 0 2px,transparent 4px),radial-gradient(circle at 54% 12%,#fff 0 2px,transparent 4px),radial-gradient(circle at 39% 34%,#29dfff 0 2px,transparent 5px),radial-gradient(circle at 61% 34%,#29dfff 0 2px,transparent 5px),radial-gradient(circle at 27% 68%,#29dfff 0 3px,transparent 6px),radial-gradient(circle at 73% 68%,#29dfff 0 3px,transparent 6px);opacity:.9}
.runway-glow{position:absolute;z-index:9;left:10%;right:10%;bottom:15%;height:110px;background:radial-gradient(ellipse,rgba(58,213,255,.52),transparent 70%);filter:blur(24px)}
.cinematic-rocket.jet-aircraft{z-index:18;width:190px;height:110px;transform-origin:50% 50%;}
.jet-fuselage{position:absolute;left:24px;top:44px;width:142px;height:23px;border-radius:52% 48% 48% 52%;background:linear-gradient(180deg,#fff 0%,#dceeff 32%,#789ec5 57%,#effaff 83%,#5b7fa7 100%);border:1px solid #e8f8ff;box-shadow:0 0 18px rgba(76,204,255,.65),inset 0 -4px 7px rgba(10,36,72,.4)}
.jet-nose{position:absolute;left:150px;top:44px;width:43px;height:23px;background:linear-gradient(180deg,#f5fbff,#769ac2 60%,#d8efff);clip-path:polygon(0 0,100% 50%,0 100%)}
.jet-wing{position:absolute;background:linear-gradient(135deg,#effaff 0%,#8fb7df 48%,#315987 100%);border:1px solid rgba(230,250,255,.9);box-shadow:0 0 12px rgba(53,192,255,.35)}
.jet-wing-main{left:63px;top:18px;width:75px;height:72px;clip-path:polygon(35% 0,100% 100%,0 66%)}
.jet-wing-tail{left:25px;top:28px;width:48px;height:46px;clip-path:polygon(30% 0,100% 100%,0 65%)}
.jet-tail-fin{position:absolute;left:30px;top:18px;width:45px;height:40px;background:linear-gradient(140deg,#f5fbff,#779bc3);clip-path:polygon(45% 0,100% 100%,0 78%)}
.jet-cockpit{position:absolute;left:113px;top:39px;width:28px;height:15px;border-radius:70% 40% 20% 20%;transform:skewX(25deg);background:linear-gradient(130deg,#e8ffff,#27bde9 44%,#123d70);border:1px solid #e8ffff;box-shadow:0 0 9px #43dfff}
.jet-engine{position:absolute;top:60px;width:23px;height:15px;border-radius:45%;background:linear-gradient(180deg,#243d5d,#071323);border:1px solid #91dfff}
.jet-engine-left{left:61px}.jet-engine-right{left:91px}
.jet-exhaust{position:absolute;top:63px;width:52px;height:10px;border-radius:50%;background:linear-gradient(90deg,rgba(255,255,255,.95),rgba(65,219,255,.8),rgba(48,119,255,.1),transparent);filter:blur(5px);animation:jetThrust .14s infinite alternate}
.jet-exhaust-left{left:10px}.jet-exhaust-right{left:40px}
.jet-engine-glow{position:absolute;left:0;top:54px;width:70px;height:35px;background:radial-gradient(ellipse,rgba(38,204,255,.7),transparent 70%);filter:blur(8px)}
.jet-flight-trail{position:absolute;right:130px;top:57px;height:5px;border-radius:100%;background:linear-gradient(90deg,transparent,rgba(80,219,255,.15),rgba(255,255,255,.85));filter:blur(4px);transform:translateX(-5%)}
@keyframes jetThrust{to{transform:scaleX(1.18);opacity:.72;filter:blur(7px)}}
@media(max-width:650px){.cinematic-rocket.jet-aircraft{transform:translate(-50%,50%) scale(.72)!important}.jet-runway{height:38%}.runway-centerline{background-size:auto 70%}}

`;



function Initials({ name, email }) {
  const source = (name || email || "U").trim();
  const parts = source.split(/\s+/).filter(Boolean);
  const initials = parts.length >= 2
    ? `${parts[0][0]}${parts[1][0]}`
    : source.slice(0, 2);
  return initials.toUpperCase();
}

function PremiumProfile({ user, profile, admin = false, stats = [], referrerProfile = null }) {
  const displayName = profile?.full_name || (admin ? "Platform Administrator" : "Customer");
  const role = admin ? "Administrator" : "Customer";

  return (
    <div className="rh-profile-shell">
      <div className="rh-profile-top">
        <div className="rh-profile-identity">
          <div className="rh-avatar"><Initials name={displayName} email={user?.email} /></div>
          <div style={{ minWidth: 0 }}>
            <div className="rh-profile-name">{displayName}</div>
            <div className="rh-profile-email">{user?.email || profile?.email || "—"}</div>
            <span className="rh-profile-badge">
              {admin ? <Crown size={12} /> : <BadgeCheck size={12} />}
              {role}
            </span>
          </div>
        </div>
      </div>

      <div className="rh-profile-grid">
        {stats.map((item) => (
          <div className="rh-profile-stat" key={item.label}>
            <span>{item.label}</span>
            <strong>{item.value}</strong>
          </div>
        ))}
      </div>
    </div>
  );
}

/* =========================================================
   LAYOUT
========================================================= */

function Layout({ children, user, isAdmin }) {
  const [open, setOpen] = useState(false);
  const location = useLocation();

  async function logout() {
    await supabase.auth.signOut();
    setOpen(false);
  }

  return (
    <div className="app-shell">
      <style>{premiumCss}</style>
      <style>{`
:root{color-scheme:dark}body{background:#060912!important;color:#edf3ff!important}.app-shell{background:radial-gradient(ellipse at 52% -12%,rgba(197,162,75,.13),transparent 48%),radial-gradient(ellipse at 92% 18%,rgba(17,133,119,.12),transparent 40%),linear-gradient(180deg,#080d18,#050812 78%,#080b13)!important;color:#edf3ff}.navbar{background:rgba(7,12,23,.97)!important;border-bottom:1px solid rgba(197,162,75,.42)!important;box-shadow:0 8px 32px rgba(0,0,0,.35)!important}.brand-mark{background:linear-gradient(145deg,#e6c66b,#8d6c2e)!important;box-shadow:0 0 22px rgba(197,162,75,.22)!important}.nav-links a.active,.nav-links a:hover{background:linear-gradient(90deg,rgba(197,162,75,.18),rgba(17,133,119,.12))!important;box-shadow:inset 0 0 0 1px rgba(197,162,75,.28)!important}.dashboard-card,.game-panel,.deposit-card,.withdraw-card{background:linear-gradient(145deg,#111b2b,#080e19)!important;border-color:rgba(145,169,198,.22)!important;box-shadow:0 18px 55px rgba(0,0,0,.38),inset 0 0 30px rgba(87,122,165,.025)!important}.eyebrow,.ta-crash-brand{color:#d9bd71!important}.btn.primary,.ta-crash-action{background:linear-gradient(135deg,#e7ca76,#a77d2f)!important;color:#101522!important;box-shadow:0 5px 24px rgba(197,162,75,.15)}.btn.secondary{border-color:#3c526b!important;color:#dce8f7!important;background:#0d1727!important}.ta-crash-action.out{background:linear-gradient(135deg,#9cebd0,#2ba981)!important;color:#041a16!important}.footer{border-top:1px solid rgba(197,162,75,.3)!important;background:#060b14!important}
.ac-games-page .ac-games-tabs{display:flex;flex-wrap:wrap;gap:10px;margin:18px 0}.ac-games-tabs button{background:linear-gradient(145deg,#101a2b,#080f1b);color:#cbd7e8;border:1px solid #344760;border-radius:13px;padding:12px 18px;font-weight:800;cursor:pointer}.ac-games-tabs button.active{background:linear-gradient(135deg,#b38a3d,#e6c86d);color:#111827;border-color:#e6c86d;box-shadow:0 0 22px #d3ae5830}.ac-games-layout{display:grid;grid-template-columns:minmax(0,1.55fr) minmax(280px,.8fr);gap:16px}.ac-game-main{border-color:#4d617a}.ac-game-top{display:flex;justify-content:space-between;align-items:flex-start;gap:15px}.ac-game-top h2{margin:7px 0 0;font-size:21px}.ac-balance{border:1px solid #40536c;background:#0a1220;padding:12px 16px;border-radius:12px;min-width:145px}.ac-balance small,.ac-balance strong{display:block}.ac-balance small{color:#91a5bf;font-size:10px;font-weight:800;letter-spacing:.1em}.ac-balance strong{color:#e6c66b;font-size:20px;margin-top:6px}.ac-round-banner{margin:18px 0;padding:15px;border:1px solid #354a63;border-radius:13px;background:linear-gradient(100deg,#111d30,#09111e);display:grid;grid-template-columns:1fr auto;gap:8px;align-items:center}.ac-round-banner span{font-size:12px;color:#d8e4f4}.ac-round-banner strong{font-size:29px;color:#e6c66b}.ac-round-banner small{grid-column:1/-1;color:#91a5bf}.ac-choice-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(105px,1fr));gap:10px;margin:18px 0}.ac-choice-grid button{padding:16px 12px;background:#0c1523;border:1px solid #354a63;border-radius:13px;color:#e7eef8;font-weight:800;cursor:pointer}.ac-choice-grid button.chosen{border-color:var(--horse-color,#d6b65f);background:linear-gradient(145deg,#1b2a3e,#101827);box-shadow:inset 0 0 0 1px #ffffff12,0 0 18px #90a4bd12}.ac-choice-grid button:disabled{opacity:.72;cursor:not-allowed}.ac-bet-row{display:flex;align-items:end;gap:12px}.ac-bet-row label{flex:1;color:#b9c9dc;font-size:12px;font-weight:800}.ac-bet-row input{display:block;width:100%;margin-top:7px;padding:13px;border-radius:10px;border:1px solid #354a63;background:#070d17;color:#fff}.ac-bet-row .btn{min-width:180px}.ac-payout-note{display:grid;gap:7px;margin-top:18px;padding:14px;border-radius:12px;background:#09111d;border:1px solid #263a52;color:#b9c9dc;font-size:13px}.ac-payout-note strong{color:#e9d28c}.ac-bet-list{display:grid;gap:8px}.ac-bet-item{display:grid;grid-template-columns:1fr auto;gap:5px;padding:10px 0;border-bottom:1px solid #1e2c40}.ac-bet-item span{color:#e8eff8}.ac-bet-item strong{color:#e6c66b}.ac-bet-item small{grid-column:1/-1;color:#8ea3bd;text-transform:capitalize}.ac-small{font-size:11px;line-height:1.5;margin-top:18px}.notice.success{color:#9fe9c9}.notice.error{color:#ff9ca6}
/* Royal Luxe theme: midnight navy, amethyst, and brushed gold */
:root{--ta-accent:#d7b65d;--ta-violet:#9b7bff;--ta-panel:#100b25;--ta-line:rgba(215,182,93,.30)}
body{background:#070511!important;color:#f7f2ff!important}
.app-shell{background:radial-gradient(ellipse at 12% -8%,rgba(111,55,190,.28),transparent 48%),radial-gradient(ellipse at 100% 18%,rgba(215,182,93,.10),transparent 38%),linear-gradient(180deg,#0c071b 0%,#070511 68%,#05040d 100%)!important;color:#f7f2ff!important}
.navbar{background:rgba(9,5,21,.97)!important;border-bottom:1px solid rgba(215,182,93,.52)!important;box-shadow:0 10px 36px rgba(0,0,0,.48),0 1px 0 rgba(155,123,255,.12)!important}
.brand-mark{background:linear-gradient(145deg,#f5df91 0%,#c59a35 52%,#7e5a1b 100%)!important;box-shadow:0 0 26px rgba(215,182,93,.28)!important}
.nav-links a.active,.nav-links a:hover{background:linear-gradient(100deg,rgba(155,123,255,.22),rgba(215,182,93,.12))!important;box-shadow:inset 0 0 0 1px rgba(215,182,93,.36)!important;color:#fff5cf!important}
.dashboard-card,.rh-rocket-card,.game-panel,.deposit-card,.withdraw-card,.admin-plan,.rh-admin-section,.player-panel,.ta-auth-card,.ac-game-main,.ac-horse-track{background:linear-gradient(145deg,rgba(24,15,45,.98),rgba(9,6,20,.99))!important;border-color:rgba(155,123,255,.24)!important;box-shadow:0 20px 60px rgba(0,0,0,.42),inset 0 1px 0 rgba(255,255,255,.035)!important}
.rh-admin-section-head,.rh-admin-section-body{border-color:rgba(215,182,93,.20)!important}
.eyebrow,.rh-section-label,.ta-crash-brand{color:#e8ca78!important}
.btn.primary,.cash-in,.ta-auth-submit,.ta-crash-action{background:linear-gradient(115deg,#f0d98c 0%,#c69b3a 48%,#927026 100%)!important;color:#171020!important;border:1px solid rgba(255,230,153,.42)!important;box-shadow:0 8px 28px rgba(190,147,48,.20),inset 0 1px 0 rgba(255,255,255,.28)!important}
.btn.secondary{border-color:rgba(155,123,255,.34)!important;color:#eee6ff!important;background:linear-gradient(135deg,#1a1230,#0e0a1b)!important}
input,select,textarea,.ta-auth-input,.ac-bet-row input,.token-input{background:#090616!important;color:#f8f3ff!important;border-color:rgba(155,123,255,.36)!important}
input:focus,select:focus,textarea:focus,.ta-auth-input:focus{border-color:#d7b65d!important;box-shadow:0 0 0 3px rgba(215,182,93,.12)!important;outline:none}
.admin-plan,.dashboard-card,.rh-admin-section,.deposit-card,.withdraw-card{border-radius:20px!important}
.admin-plan h2,.rh-admin-section h2,.dashboard-card h2{color:#fff5d7!important}
.ac-games-tabs button{background:linear-gradient(145deg,#1a1230,#0c081a)!important;border-color:rgba(155,123,255,.32)!important;color:#e9ddff!important}
.ac-games-tabs button.active{background:linear-gradient(120deg,#f0d98c,#b98a2c)!important;color:#160f20!important;border-color:#f1d98a!important;box-shadow:0 0 24px rgba(215,182,93,.22)!important}
.ac-balance strong,.ac-round-banner strong,.ac-multiplier-number,.ac-bet-item strong{color:#e8ca78!important}
.ac-round-banner,.ac-payout-note,.ac-balance,.ac-choice-grid button{background:linear-gradient(140deg,#17102a,#0a0717)!important;border-color:rgba(155,123,255,.26)!important}
.ac-multiplier-number.is-running{color:#a9f5d1!important}
.ta-auth-mark{background:linear-gradient(140deg,#f4df9b,#b98b30 58%,#78531a)!important;color:#1a1022!important;box-shadow:0 0 32px rgba(215,182,93,.2)!important}
.footer{border-top:1px solid rgba(215,182,93,.3)!important;background:#080512!important}
@media(max-width:850px){.ac-games-layout{grid-template-columns:1fr}.ac-game-top{flex-direction:column}.ac-bet-row{align-items:stretch;flex-direction:column}.ac-bet-row .btn{width:100%}}
/* Royal luxury theme: midnight navy, imperial purple, champagne gold, emerald accents */
:root{--royal-gold:#e8cc83;--royal-gold-deep:#9e7939;--royal-purple:#6d4bd1;--royal-emerald:#38c99a;--royal-line:rgba(232,204,131,.24)}
body{background:#070611!important;color:#f7f1df!important}
.app-shell{background:radial-gradient(ellipse at 12% -10%,rgba(109,75,209,.24),transparent 48%),radial-gradient(ellipse at 90% 10%,rgba(56,201,154,.10),transparent 42%),linear-gradient(180deg,#0b0818 0%,#080916 55%,#050710 100%)!important}
.navbar{background:rgba(9,7,20,.94)!important;border-bottom:1px solid rgba(232,204,131,.38)!important;box-shadow:0 12px 38px rgba(0,0,0,.42)!important}
.brand{color:#f6e7bb!important;letter-spacing:.045em}.brand-mark{background:linear-gradient(145deg,#f6e7b0,#b68b3c 52%,#6848c8)!important;border:1px solid rgba(255,240,194,.62)!important;box-shadow:0 0 25px rgba(232,204,131,.24)!important}
.nav-links a.active,.nav-links a:hover{color:#fff4d5!important;background:linear-gradient(100deg,rgba(109,75,209,.28),rgba(232,204,131,.12))!important;box-shadow:inset 0 0 0 1px rgba(232,204,131,.28)!important}
.dashboard-card,.game-panel,.deposit-card,.withdraw-card,.admin-plan,.rh-admin-section{background:linear-gradient(145deg,rgba(24,18,43,.97),rgba(9,10,24,.98))!important;border-color:rgba(232,204,131,.22)!important;box-shadow:0 22px 60px rgba(0,0,0,.42),inset 0 1px rgba(255,255,255,.025)!important}
.eyebrow,.rh-section-label,.section-heading .eyebrow{color:var(--royal-gold)!important}
.btn.primary,.ta-auth-submit,.ta-crash-action{background:linear-gradient(135deg,#f2dfa0 0%,#c49a4d 55%,#8d682d 100%)!important;color:#171020!important;border:1px solid rgba(255,238,182,.55)!important;box-shadow:0 8px 26px rgba(197,154,77,.19)!important}
.btn.secondary{background:linear-gradient(135deg,#21183d,#111024)!important;border:1px solid rgba(157,130,225,.34)!important;color:#e8ddff!important}
input,select,textarea,.ta-auth-input{background-color:#0b0a1b!important;border-color:rgba(164,145,206,.3)!important;color:#fff8e9!important}
input:focus,select:focus,textarea:focus,.ta-auth-input:focus{border-color:var(--royal-gold)!important;box-shadow:0 0 0 3px rgba(232,204,131,.12)!important}
.rh-admin-section-head h2,.section-heading h1{color:#f5e7c4!important}
.rh-admin-section-body{border-color:rgba(232,204,131,.13)!important}
.admin-plan{border:1px solid rgba(232,204,131,.2)!important;border-radius:18px!important;padding:18px!important}
.rh-empty{border:1px dashed rgba(232,204,131,.28)!important;background:rgba(22,15,40,.55)!important;color:#c5b9dc!important}
.notice.success{color:#7fe4ba!important}.notice.error{color:#ff9cae!important}
.footer{background:#080716!important;border-top:1px solid rgba(232,204,131,.22)!important}
@media(max-width:650px){.page-section{padding-left:14px!important;padding-right:14px!important}.navbar{padding:8px 13px!important}.brand{font-size:19px!important}}
.game-center-heading{position:relative}.dt-music-bar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:12px;padding:10px 12px;border:1px solid #3b2b64;border-radius:14px;background:linear-gradient(135deg,#100d22,#08141c);box-shadow:0 0 22px #7c3aed18}.dt-music-bar button{border:1px solid #6d5ad8;background:linear-gradient(135deg,#21154a,#0d2830);color:#fff;border-radius:10px;padding:9px 12px;font-weight:1000;cursor:pointer}.dt-music-bar label{font-size:10px;font-weight:900;color:#9aa9c1;display:flex;align-items:center;gap:6px}.dt-music-bar input{width:75px;accent-color:#36f1c5}.dt-music-bar small{color:#718198}.ac-games-page{position:relative}.ac-games-page:before{content:"";position:fixed;inset:0;pointer-events:none;background:radial-gradient(circle at 15% 10%,#7c3aed12,transparent 28%),radial-gradient(circle at 90% 70%,#00e5d412,transparent 30%);z-index:-1}.dt-board{position:relative;padding:6px;border-radius:28px;background:linear-gradient(135deg,#1b1237,#07151d 52%,#2a180b);box-shadow:0 0 45px #0008,inset 0 0 35px #ffffff05}.dt-animal-card{min-height:390px;background:radial-gradient(circle at 50% 25%,#ffffff0d,transparent 34%),linear-gradient(145deg,#111426,#080910 65%,#180d1b);backdrop-filter:blur(4px)}.dt-animal-card:after{content:"";position:absolute;inset:8px;border:1px solid #ffffff10;border-radius:18px;pointer-events:none}.dt-animal-art{height:250px;display:grid;place-items:center;position:relative;z-index:1}.dt-real-art{width:min(94%,390px);height:250px;filter:drop-shadow(0 18px 20px #000b)}.dt-animal-card.selected .dt-real-art{filter:drop-shadow(0 0 20px var(--animal-color)) drop-shadow(0 18px 20px #000b)}.dt-animal-name{font-size:32px;text-shadow:0 0 18px var(--animal-color)}.dt-countdown-critical{animation:dtPulse .45s ease-in-out infinite alternate}@keyframes dtPulse{from{transform:scale(1)}to{transform:scale(1.08);text-shadow:0 0 24px #ff304d}}@media(max-width:650px){.dt-animal-card{min-height:330px}.dt-animal-art{height:205px}.dt-real-art{height:205px}.dt-animal-name{font-size:27px}.dt-music-bar small{width:100%}}`}</style>
      <header className="navbar">
        <Link className="brand" to="/" onClick={() => setOpen(false)}>
          <span className="brand-mark" aria-label="TA777Gaming car logo" />
          TA777Gaming
        </Link>

        <button className="menu-btn" onClick={() => setOpen((v) => !v)} aria-label="Menu" type="button">
          {open ? <X size={22} /> : <Menu size={22} />}
        </button>

        <nav className={open ? "nav-links open" : "nav-links"}>
          <Link className={location.pathname === "/" ? "active" : ""} to="/" onClick={() => setOpen(false)}>Home</Link>
          {user && <Link className={location.pathname === "/games" ? "active" : ""} to="/games" onClick={() => setOpen(false)}>Games</Link>}
          <Link className={location.pathname === "/how-it-works" ? "active" : ""} to="/how-it-works" onClick={() => setOpen(false)}>How It Works</Link>

          {!user && (
            <>
              <Link className={location.pathname === "/login" ? "active" : ""} to="/login" onClick={() => setOpen(false)}>Login</Link>
              <Link className={location.pathname === "/register" ? "active" : ""} to="/register" onClick={() => setOpen(false)}>Register</Link>
            </>
          )}

          {user && <Link className="nav-dashboard" to="/dashboard" onClick={() => setOpen(false)}>Dashboard</Link>}
          {isAdmin && <Link className="nav-dashboard" to="/admin" onClick={() => setOpen(false)}>Admin</Link>}
          {user && <button type="button" className="nav-dashboard" onClick={logout}><LogOut size={16} /> Logout</button>}
        </nav>
      </header>
      <main>{children}</main>
      <footer className="footer">
        <div><strong>TA777Gaming</strong><p>A premium arena for Graph Game and Horse Racing.</p></div>
        <span>© 2026 TA777Gaming</span>
      </footer>
    </div>
  );
}

/* =========================================================
   HOME
========================================================= */

function Home() {
  return (
    <>
      <section className="hero ta-home-premium">
        <div className="hero-copy">
          <span className="eyebrow">TA777 · LIVE GAME ARENA</span>
          <h1>TA777Gaming</h1>
          <p>Choose your game and join the live action with AC tokens.</p>
          <div className="hero-actions">
            <Link className="btn primary" to="/games">Open Game Center <ArrowRight size={18} /></Link>
          </div>
        </div>
        <div className="hero-card ta-home-game-card">
          <div className="ta-home-game-row"><span className="ta-home-game-icon">📈</span><div><h3>Graph Game</h3><p>Watch the multiplier rise. Cash out before the random reset.</p></div></div>
          <div className="ta-home-game-row"><span className="ta-home-game-icon">🏇</span><div><h3>Horse Racing</h3><p>Pick one of five horses and follow the live race.</p></div></div>
        </div>
      </section>
      <section className="section ta-home-games">
        <div className="section-heading"><span className="eyebrow">CHOOSE YOUR GAME</span><h2>Two games. One arena.</h2></div>
        <div className="feature-grid">
          <Feature icon={<BarChart3 />} title="Graph Game" text="Cash out while the multiplier is rising." />
          <Feature icon={<CreditCard />} title="Horse Racing" text="Choose a horse before betting closes and watch the race." />
        </div>
      </section>
    </>
  );
}

function Feature({ icon, title, text }) {
  return <div className="feature-card"><div className="feature-icon">{icon}</div><h3>{title}</h3><p>{text}</p></div>;
}

/* =========================================================
   PLANS
========================================================= */

function Plans() {
  const navigate = useNavigate();
  return <section className="page-section">
    <div className="section-heading"><span className="eyebrow">GAME CENTER</span><h1>Graph Game & Horse Racing</h1><p>Choose a live game and join a round with AC tokens.</p></div>
    <div className="dashboard-card">
      <h2>Ready to play?</h2>
      <p className="muted">Join Graph Game or Horse Racing with other players.</p>
      <button className="btn primary" type="button" onClick={()=>navigate("/games")}>Open Game Center <ArrowRight size={18}/></button>
    </div>
    <div className="notice"><strong>Shared currency:</strong> AC is the platform currency used for game play and account balance.</div>
  </section>;
}

function HowItWorks() {
  return <section className="page-section narrow"><div className="section-heading"><span className="eyebrow">HOW IT WORKS</span><h1>Simple customer journey</h1></div>
    <div className="steps">
      {["Create an account","Open Graph Game or Horse Racing","Place an AC token bet","Follow the round and results"].map((title,i)=><div className="step" key={title}><span>{String(i+1).padStart(2,"0")}</span><div><h3>{title}</h3><p>{["Register your customer account.","Open either live game from the game center.","Choose a stake and, for racing, select a horse during the betting window.","Cash out before the graph resets or check the announced winning horse after a race."][i]}</p></div></div>)}
    </div>
  </section>;
}

/* =========================================================
   AUTH
========================================================= */

function Auth({ mode }) {
  const navigate = useNavigate();
  const isRegister = mode === "register";
  const [method, setMethod] = useState("email");
  const [form, setForm] = useState({name:"",email:"",phone:"",password:"",referral:""});
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    const ref = new URLSearchParams(window.location.search).get("ref");
    if (ref) setForm((c)=>({...c,referral:ref}));
  }, []);

  function updateField(field,value){setForm((c)=>({...c,[field]:value}));}

  async function submit(e){
    e.preventDefault(); setLoading(true); setMessage(""); setError("");
    try{
      const contact = method === "email" ? form.email.trim().toLowerCase() : form.phone.trim();
      if (!contact) throw new Error(method === "email" ? "Enter your email address." : "Enter your phone number with country code, for example +923001234567.");
      if (method === "phone" && !/^\+[1-9]\d{7,14}$/.test(contact)) {
        throw new Error("Enter your phone number with country code, for example +923001234567.");
      }
      if(isRegister){
        const referralCode=form.referral.trim()||null;
        const metadata={full_name:form.name.trim(),phone:method==="phone"?contact:form.phone.trim()||null,referral_code:referralCode,referred_by_code:referralCode};
        const credentials = method === "email"
          ? {email:contact,password:form.password,options:{data:metadata}}
          : {phone:contact,password:form.password,options:{data:metadata}};
        const {data,error:signUpError}=await supabase.auth.signUp(credentials);
        if(signUpError) throw signUpError;
        if(data.user&&referralCode) await saveReferralRelationship(data.user.id,referralCode);
        if(data.session){setMessage("Account created successfully.");setTimeout(()=>navigate("/dashboard"),700);}
        else setMessage(method === "email" ? "Account created. Check your email for the confirmation link." : "Account created. Check your phone for the verification code. Phone verification must be enabled in Supabase.");
      }else{
        const credentials = method === "email"
          ? {email:contact,password:form.password}
          : {phone:contact,password:form.password};
        const {data,error:loginError}=await supabase.auth.signInWithPassword(credentials);
        if(loginError) throw loginError;
        if(!data.user) throw new Error("Login failed.");
        const {data:profile,error:profileError}=await supabase.from("profiles").select("role,referral_code").eq("id",data.user.id).maybeSingle();
        if(profileError) throw profileError;
        if(!profile){
          await supabase.auth.signOut();
          throw new Error("This customer ID no longer exists. The account was deleted by the administrator.");
        }
        const metadataReferral=data.user.user_metadata?.referred_by_code||data.user.user_metadata?.referral_code||profile?.referral_code;
        if(data.user&&metadataReferral) await saveReferralRelationship(data.user.id,metadataReferral);
        setMessage("Login successful."); setTimeout(()=>navigate(profile?.role === "admin" ? "/admin" : "/dashboard"),500);
      }
    }catch(err){console.error(err);setError(err?.message||"Something went wrong.");}
    finally{setLoading(false);}
  }

  return <section className="auth-wrap"><form className="auth-card ta-auth-card" onSubmit={submit}>
    <div className="ta-auth-mark">TA<span>777</span></div>
    <span className="eyebrow">{isRegister?"PLAYER REGISTRATION":"SECURE PLAYER LOGIN"}</span>
    <h1>{isRegister?"Create your account":"Welcome back"}</h1>
    <p className="muted">{isRegister?"Choose how you want to register.":"Sign in using your email or phone number."}</p>
    <div className="ta-auth-methods" role="group" aria-label="Choose sign-in method">
      <button type="button" className={method==="email"?"selected":""} onClick={()=>setMethod("email")}><span>✉</span> Email</button>
      <button type="button" className={method==="phone"?"selected":""} onClick={()=>setMethod("phone")}><span>☎</span> Phone number</button>
    </div>
    {isRegister&&<label>Full name<input className="ta-auth-input" type="text" value={form.name} onChange={(e)=>updateField("name",e.target.value)} required autoComplete="name" placeholder="Enter your full name"/></label>}
    {method==="email" ? <label>Email address<input className="ta-auth-input" type="email" value={form.email} onChange={(e)=>updateField("email",e.target.value)} required autoComplete="email" placeholder="you@example.com"/></label> : <label>Phone number<input className="ta-auth-input" type="tel" value={form.phone} onChange={(e)=>updateField("phone",e.target.value)} required autoComplete="tel" placeholder="+923001234567"/><small className="ta-auth-hint">Include your country code. Phone sign-up requires phone authentication enabled in Supabase.</small></label>}
    <label>Password<input className="ta-auth-input" type="password" value={form.password} onChange={(e)=>updateField("password",e.target.value)} required minLength={6} autoComplete={isRegister?"new-password":"current-password"} placeholder={isRegister?"Create a password (6+ characters)":"Enter your password"}/></label>
    {isRegister&&<label>Referral code <span className="ta-auth-optional">(optional)</span><input className="ta-auth-input" type="text" value={form.referral} onChange={(e)=>updateField("referral",e.target.value)} placeholder="Enter referral code, if any"/></label>}
    <button className="btn primary full ta-auth-submit" type="submit" disabled={loading}>{loading?"Please wait…":isRegister?"Create account":"Sign in"}</button>
    {error&&<div className="error" role="alert">{error}</div>}{message&&<div className="success" role="status">{message}</div>}
    <button type="button" className="text-btn ta-auth-switch" onClick={()=>navigate(isRegister?"/login":"/register")}>{isRegister?"Already have an account? Sign in":"New to TA777Gaming? Create an account"}</button>
    <div className="ta-auth-secure">🔒 Your account details are protected</div>
  </form></section>;
}

/* =========================================================
   CONTINUOUS VIRTUAL CAR CRASH GAME
========================================================= */

const ROCKET_VIRTUAL_BALANCE_KEY = "rh_virtual_ac_tokens_v1_";
const ROCKET_LOCAL_BET_KEY = "rh_virtual_rocket_bet_v1_";

function RocketGame({ user }) {
  const [round,setRound]=useState(null),[players,setPlayers]=useState([]),[userBets,setUserBets]=useState([]);
  const [balance,setBalance]=useState(0),[amounts,setAmounts]=useState(["",""]),[multiplier,setMultiplier]=useState(1);
  const [history,setHistory]=useState([]),[chat,setChat]=useState([]),[chatText,setChatText]=useState(""),[tab,setTab]=useState("all");
  const [error,setError]=useState(""),[message,setMessage]=useState(""),[loading,setLoading]=useState(true),[busyPanel,setBusyPanel]=useState(null),[now,setNow]=useState(Date.now());
  const [musicOn,setMusicOn]=useState(()=>{try{return localStorage.getItem("ta777_music_on")==="true";}catch{return false;}});
  const [effectsOn,setEffectsOn]=useState(()=>{try{return localStorage.getItem("ta777_effects_on")==="true";}catch{return true;}});
  const [musicVolume,setMusicVolume]=useState(()=>{try{return Number(localStorage.getItem("ta777_music_volume")||25);}catch{return 25;}});
  const [effectsVolume,setEffectsVolume]=useState(()=>{try{return Number(localStorage.getItem("ta777_effects_volume")||65);}catch{return 65;}});
  const audioRef=useRef(null),musicNodesRef=useRef(null),lastSoundRoundRef=useRef(null),blastPlayedRef=useRef(null);
  function getAudio(){
    if(typeof window==="undefined")return null;
    const Ctx=window.AudioContext||window.webkitAudioContext;if(!Ctx)return null;
    if(!audioRef.current)audioRef.current=new Ctx();
    if(audioRef.current.state==="suspended")audioRef.current.resume().catch(()=>{});
    return audioRef.current;
  }
  function stopMusic(){const nodes=musicNodesRef.current;if(nodes){try{nodes.oscs.forEach(o=>o.stop());nodes.gain.disconnect();}catch{}musicNodesRef.current=null;}}
  function startMusic(){const ctx=getAudio();if(!ctx||musicNodesRef.current)return;const gain=ctx.createGain();gain.gain.value=(Math.max(0,Math.min(100,musicVolume))/100)*0.045;gain.connect(ctx.destination);const oscs=[ctx.createOscillator(),ctx.createOscillator()];oscs[0].type="sine";oscs[0].frequency.value=110;oscs[1].type="sine";oscs[1].frequency.value=164.81;const g1=ctx.createGain(),g2=ctx.createGain();g1.gain.value=.72;g2.gain.value=.28;oscs[0].connect(g1);oscs[1].connect(g2);g1.connect(gain);g2.connect(gain);oscs.forEach(o=>o.start());musicNodesRef.current={oscs,gain};}
  function playEffect(kind){if(!effectsOn)return;const ctx=getAudio();if(!ctx)return;const vol=Math.max(0,Math.min(100,effectsVolume))/100;if(vol<=0)return;const t=ctx.currentTime;
    if(kind==="takeoff"){const osc=ctx.createOscillator(),gain=ctx.createGain();osc.type="sawtooth";osc.frequency.setValueAtTime(95,t);osc.frequency.exponentialRampToValueAtTime(520,t+1.25);gain.gain.setValueAtTime(.0001,t);gain.gain.exponentialRampToValueAtTime(.12*vol,t+.08);gain.gain.exponentialRampToValueAtTime(.0001,t+1.4);osc.connect(gain);gain.connect(ctx.destination);osc.start(t);osc.stop(t+1.45);}
    if(kind==="blast"){const n=Math.floor(ctx.sampleRate*.65),buffer=ctx.createBuffer(1,n,ctx.sampleRate),data=buffer.getChannelData(0);for(let i=0;i<n;i++)data[i]=(Math.random()*2-1)*(1-i/n);const src=ctx.createBufferSource(),filter=ctx.createBiquadFilter(),gain=ctx.createGain();src.buffer=buffer;filter.type="lowpass";filter.frequency.setValueAtTime(1200,t);filter.frequency.exponentialRampToValueAtTime(90,t+.6);gain.gain.setValueAtTime(.0001,t);gain.gain.exponentialRampToValueAtTime(.32*vol,t+.025);gain.gain.exponentialRampToValueAtTime(.0001,t+.64);src.connect(filter);filter.connect(gain);gain.connect(ctx.destination);src.start(t);src.stop(t+.66);}
  }
  function toggleMusic(){const next=!musicOn;setMusicOn(next);try{localStorage.setItem("ta777_music_on",String(next));}catch{}if(next)startMusic();else stopMusic();}
  function toggleEffects(){const next=!effectsOn;setEffectsOn(next);try{localStorage.setItem("ta777_effects_on",String(next));}catch{}}
  function changeMusicVolume(value){const v=Number(value);setMusicVolume(v);try{localStorage.setItem("ta777_music_volume",String(v));}catch{}if(musicNodesRef.current)musicNodesRef.current.gain.gain.setTargetAtTime((v/100)*.045,audioRef.current?.currentTime||0,.06);}
  function changeEffectsVolume(value){const v=Number(value);setEffectsVolume(v);try{localStorage.setItem("ta777_effects_volume",String(v));}catch{}}
  useEffect(()=>{if(musicOn)startMusic();else stopMusic();return()=>stopMusic();},[musicOn]);
  useEffect(()=>{if(!round?.id)return;if(lastSoundRoundRef.current!==round.id){const isFirst=lastSoundRoundRef.current===null;lastSoundRoundRef.current=round.id;blastPlayedRef.current=null;if(!isFirst)playEffect("takeoff");}if((String(round.status).toLowerCase()==="blasted"||(round.crash_at&&Date.now()>=new Date(round.crash_at).getTime()))&&blastPlayedRef.current!==round.id){blastPlayedRef.current=round.id;playEffect("blast");}},[round,now]);
  const activeStatuses=["active","live","joined","playing"];
  async function loadBalance(){try{const r=await supabase.rpc("ta_get_balance");if(r.error)throw r.error;setBalance(Number(r.data||0));}catch(e){setError(e?.message||"Could not load TA balance.");}}
  async function loadRound(){try{const r=await supabase.rpc("rh_demo_current_rocket_round");if(r.error)throw r.error;const next=Array.isArray(r.data)?r.data[0]:r.data;if(next){setRound(prev=>{if(prev?.id&&prev.id!==next.id){setHistory(h=>[{id:prev.id,multiplier:Number(prev.crash_multiplier||1),ended_at:prev.blasted_at||prev.crash_at},...h].slice(0,40));}return next;});}setError("");return next||null;}catch(e){setError(e?.message||"Could not connect to the shared game.");return null;}finally{setLoading(false);}}
  async function loadPlayers(active=round){if(!active?.id)return;try{const r=await supabase.rpc("ta_rocket_round_bets",{p_round_id:active.id});if(r.error)throw r.error;const rows=Array.isArray(r.data)?r.data:[];const list=rows.map((row,i)=>({id:row.id||`${row.user_id||"player"}-${i}`,user_id:row.user_id,amount:Number(row.stake??row.amount??0),status:String(row.status||"active").toLowerCase(),name:row.user_id===user?.id?"You":(row.display_name||`Player ${String(i+1).padStart(2,"0")}`),panel:Number(row.panel_slot||1),cashout:Number(row.cashout_multiplier||0),payout:Number(row.payout||0)}));setPlayers(list);setUserBets(list.filter(x=>x.user_id===user?.id));}catch(e){console.warn("Live bets",e);}}
  async function loadHistory(){try{const r=await supabase.rpc("ta_rocket_history",{p_limit:40});if(!r.error&&Array.isArray(r.data))setHistory(r.data.map(x=>({id:x.id,multiplier:Number(x.crash_multiplier||1),ended_at:x.blasted_at||x.crash_at})));}catch(e){console.warn("Round history",e);}}
  async function loadChat(active=round){if(!active?.id)return;try{const r=await supabase.from("ta_rocket_chat_messages").select("id,round_id,user_id,message,created_at").eq("round_id",active.id).order("created_at",{ascending:false}).limit(40);if(!r.error)setChat((r.data||[]).reverse());}catch(e){console.warn("Game chat",e);}}
  useEffect(()=>{loadRound().then(r=>{loadPlayers(r);loadChat(r);});loadBalance();loadHistory();const tick=setInterval(()=>setNow(Date.now()),100);const sync=setInterval(async()=>{const r=await loadRound();await loadBalance();if(r){await Promise.all([loadPlayers(r),loadChat(r)]);}},1200);return()=>{clearInterval(tick);clearInterval(sync);};},[user?.id]);
  useEffect(()=>{if(!round?.started_at)return;const elapsed=Math.max(0,(now-new Date(round.started_at).getTime())/1000);const live=Math.exp(elapsed/15);const crash=Number(round.crash_multiplier||live);setMultiplier(Math.max(1,Math.min(live,crash)));},[round,now]);
  async function join(panel){setError("");setMessage("");if(!round){setError("Waiting for the next round.");return;}if(String(round.status||"").toLowerCase()!=="active"||Date.now()>=new Date(round.crash_at).getTime()){setError("This round has ended. Join the next round.");return;}if(userBets.some(b=>b.panel===panel+1&&activeStatuses.includes(b.status))){setError(`Bet panel ${panel+1} already has an active bet.`);return;}const stake=Number(amounts[panel]);if(!Number.isFinite(stake)||stake<1){setError(`Enter at least 1 TA in panel ${panel+1}.`);return;}if(stake>balance){setError("Not enough TA tokens.");return;}setBusyPanel(panel);try{const r=await supabase.rpc("ta_join_rocket",{p_round_id:round.id,p_stake:stake,p_panel_slot:panel+1});if(r.error)throw r.error;setAmounts(prev=>prev.map((v,i)=>i===panel?"":v));await Promise.all([loadBalance(),loadPlayers(round)]);setMessage(`Panel ${panel+1}: bet placed for ${stake.toLocaleString()} TA.`);}catch(e){setError(e?.message||"Could not place bet. Apply the supplied SQL migration first.");}finally{setBusyPanel(null);}}
  async function cashOut(panel){const bet=userBets.find(b=>b.panel===panel+1&&activeStatuses.includes(b.status));if(!bet?.id)return;setBusyPanel(panel);setError("");setMessage("");try{if(!round||Date.now()>=new Date(round.crash_at).getTime()){setMessage("Too late — the round crashed.");await loadPlayers(round);return;}const r=await supabase.rpc("ta_cashout_rocket",{p_player_id:bet.id});if(r.error)throw r.error;await Promise.all([loadBalance(),loadPlayers(round)]);setMessage(`Panel ${panel+1} cashed out successfully.`);}catch(e){setError(e?.message||"Cash out failed.");}finally{setBusyPanel(null);}}
  async function sendChat(e){e.preventDefault();const msg=chatText.trim();if(!msg||!round?.id)return;setChatText("");try{const r=await supabase.from("ta_rocket_chat_messages").insert({round_id:round.id,user_id:user.id,message:msg.slice(0,300)});if(r.error)throw r.error;await loadChat(round);}catch(e){setError(e?.message||"Chat is unavailable. Apply the SQL migration first.");setChatText(msg);}}
  const elapsed=round?.started_at?Math.max(0,(now-new Date(round.started_at).getTime())/1000):0;const duration=round?.started_at&&round?.crash_at?Math.max(.5,(new Date(round.crash_at).getTime()-new Date(round.started_at).getTime())/1000):45;const progress=Math.min(1,elapsed/duration);const curveProgress=round?.status==="blasted"?1:Math.max(.025,progress);
  const planeX=3+curveProgress*94;const planeY=94-Math.pow(curveProgress,1.65)*93;
  const pts=Array.from({length:30},(_,i)=>{const t=(i/29)*curveProgress;const x=3+t*94;const y=94-Math.pow(t,1.65)*93;return `${i===0?"M":"L"}${x.toFixed(1)},${y.toFixed(1)}`;}).join(" ");
  const visible=players.filter(p=>tab==="mine"?p.user_id===user?.id:true).slice(0,60);const totalStake=players.reduce((n,p)=>n+p.amount,0);const cashed=players.filter(p=>p.status==="cashed_out");const topWin=[...cashed].sort((a,b)=>b.payout-a.payout)[0];
  const panelCard=(panel)=>{const bet=userBets.find(b=>b.panel===panel+1&&activeStatuses.includes(b.status));const settled=userBets.find(b=>b.panel===panel+1&&b.status==="cashed_out");const stake=Number(bet?.amount||settled?.amount||0);const potential=bet?Number((stake*multiplier).toFixed(2)):0;return <form className="ta-crash-box ta-crash-betpanel" key={panel} onSubmit={e=>{e.preventDefault();join(panel);}}><div className="ta-crash-panelhead"><b>BET PANEL {panel+1}</b><span>{bet?"BET ACTIVE":settled?`CASHED OUT ${settled.cashout.toFixed(2)}×`:"MANUAL BET"}</span></div><small>STAKE · TA TOKENS</small><strong>{bet||settled?`${stake.toLocaleString()} TA`:"Enter stake"}</strong><input className="ta-crash-input" type="number" inputMode="decimal" min="1" step="1" value={amounts[panel]} onChange={e=>setAmounts(prev=>prev.map((v,i)=>i===panel?e.target.value:v))} placeholder="Enter TA amount" disabled={Boolean(bet)||busyPanel!==null}/><div className="ta-crash-quick"><button type="button" onClick={()=>setAmounts(v=>v.map((x,i)=>i===panel?String(Math.max(1,Math.floor(Number(x||0)/2))):x))}>½</button><button type="button" onClick={()=>setAmounts(v=>v.map((x,i)=>i===panel?String(Number(x||0)*2||2):x))}>2×</button><button type="button" onClick={()=>setAmounts(v=>v.map((x,i)=>i===panel?String(Math.floor(balance)):x))}>MAX</button></div><div className="ta-crash-panel-return"><small>{bet?"POTENTIAL RETURN":settled?"PAYOUT":"AVAILABLE BALANCE"}</small><strong>{bet?`${potential.toLocaleString()} TA`:settled?`${settled.payout.toLocaleString()} TA`:balance.toLocaleString()+" TA"}</strong></div>{!bet&&!settled?<button className="ta-crash-action" type="submit" disabled={busyPanel!==null||loading||String(round?.status)!=="active"}>PLACE BET {panel+1}</button>:bet?<button className="ta-crash-action out" type="button" onClick={()=>cashOut(panel)} disabled={busyPanel!==null||String(round?.status)!=="active"}>CASH OUT · {multiplier.toFixed(2)}×</button>:<button className="ta-crash-action" type="button" disabled>SETTLED · NEXT ROUND</button>}</form>;};
  return <section className="page-section ta-crash-page">
    <style>{`.ta-crash-page{color:#fff}.ta-crash-board{background:linear-gradient(180deg,#120508 0%,#26060b 45%,#090609 46%,#090609 100%)!important;border-color:#6e0b16!important;box-shadow:inset 0 0 60px rgba(255,0,20,.16),0 0 32px rgba(255,0,20,.08)}.ta-crash-mult{color:#ff2638!important;text-shadow:0 0 28px rgba(255,0,25,.8)!important}.ta-crash-road{position:absolute;left:0;right:0;top:48%;height:40%;background:linear-gradient(180deg,#27070c 0%,#080808 18%,#141414 50%,#070707 100%);border-top:3px solid #b20d20;border-bottom:3px solid #b20d20;box-shadow:0 -12px 30px #e0002430,0 12px 28px #e0002430}.ta-crash-road:before{content:"";position:absolute;left:0;right:0;top:52%;height:5px;background:repeating-linear-gradient(90deg,#ff3344 0 44px,transparent 44px 86px);animation:taRoadDash .55s linear infinite}.ta-crash-road:after{content:"";position:absolute;left:0;right:0;top:0;height:100%;background:repeating-linear-gradient(90deg,transparent 0 16%,#ff1d3320 16.2% 16.5%,transparent 16.7% 32%);animation:taRoadLines .7s linear infinite}.ta-crash-car{position:absolute;z-index:5;display:flex;align-items:center;gap:0;transform:translate(-50%,-50%);transition:left .12s linear;filter:drop-shadow(0 0 13px rgba(255,0,25,.85));animation:taCarVibrate .12s infinite alternate}.ta-car-emoji{font-size:clamp(42px,7vw,68px);line-height:1;filter:saturate(1.35);transform:scaleX(-1)}.ta-car-flame{font-size:clamp(15px,2.5vw,23px);font-weight:1000;color:#ff2638;letter-spacing:-7px;text-shadow:0 0 12px #ff1028;transform:translateX(-4px)}.ta-crash-car.is-crashed .ta-car-emoji,.ta-crash-car.is-crashed .ta-car-flame{visibility:hidden}.ta-crash-car.is-crashed:after{content:"💥";font-size:clamp(45px,8vw,76px);position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);filter:drop-shadow(0 0 18px #ff142c);animation:taBoom .35s ease-out infinite alternate}@keyframes taBoom{to{transform:translate(-50%,-50%) scale(1.18)}}@keyframes taRoadDash{to{background-position:86px 0}}@keyframes taRoadLines{to{background-position:-90px 0}}@keyframes taCarVibrate{from{margin-top:-1px}to{margin-top:2px}}.ta-crash-audio-btn{border-color:#65111b!important;background:#16090b!important;color:#ffd7db!important}.ta-crash-audio-btn.on{border-color:#ff2438!important;color:#fff!important;background:#4b0710!important}.ta-crash-pill{border-color:#72121e!important;background:#1b080b!important}.ta-crash-box,.ta-crash-playerlist,.ta-crash-stat{background:#10090a!important;border-color:#4b151c!important}.ta-crash-box small,.ta-crash-stat small{color:#c19a9e!important}.ta-crash-input,.ta-chat-form input{background:#070506!important;border-color:#5a171f!important}.ta-crash-panelhead,.ta-chat-row b{color:#ff5360!important}.ta-crash-quick button,.ta-crash-tabs button{background:#1b0b0e!important;border-color:#57141e!important;color:#f4c7cc!important}.ta-crash-tabs button.active{background:#9b0717!important;border-color:#ff3445!important;color:#fff!important}.ta-crash-history span{background:#1b080c!important;border-color:#64121e!important;color:#ff7580!important}.ta-chat-form button{background:#d90b20!important;color:#fff!important}.ta-crash-page{color:#eef7ff}.ta-crash-audio{display:flex;align-items:center;justify-content:flex-end;gap:8px;flex-wrap:wrap}.ta-crash-audio-btn{border:1px solid #28445c;background:#0b1c2c;color:#a9cce1;padding:9px 11px;border-radius:10px;font-weight:800;cursor:pointer}.ta-crash-audio-btn.on{border-color:#35c6e7;color:#8deaff;background:#10324a}.ta-crash-audio label{display:flex;align-items:center;gap:5px;color:#8caac2;font-size:11px}.ta-crash-audio input[type=range]{width:76px;accent-color:#35c6e7}@media(max-width:760px){.ta-crash-audio{justify-content:flex-start}.ta-crash-audio label{font-size:10px}.ta-crash-audio input[type=range]{width:60px}}.ta-crash-top{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:16px}.ta-crash-brand{font-weight:900;letter-spacing:1.8px;color:#8deaff}.ta-crash-pill{border:1px solid #24506b;background:#0b1c2c;padding:8px 12px;border-radius:999px;font-size:12px}.ta-crash-board{background:radial-gradient(ellipse at 48% 110%,#173c68 0%,#09192d 45%,#050b16 100%);border:1px solid #1b3c59;border-radius:20px;overflow:hidden;position:relative;height:clamp(300px,52vw,470px)}.ta-crash-mult{position:absolute;z-index:3;inset:55px 10px auto;text-align:center;font-size:clamp(44px,9vw,76px);font-weight:900;letter-spacing:-2px;color:#fff;text-shadow:0 0 26px #1daeff88;pointer-events:none}.ta-crash-state{position:absolute;top:16px;left:18px;color:#8daec7;font-size:11px;letter-spacing:1px;z-index:4}.ta-crash-chart{position:absolute;inset:0;width:100%;height:100%}.ta-crash-curve{fill:none;stroke:#7fe7ff;stroke-width:1.7;filter:drop-shadow(0 0 7px #32c8ff)}.ta-crash-fill{fill:url(#taCrashFill);opacity:.5}.ta-crash-plane{position:absolute;z-index:4;font-size:clamp(28px,5vw,45px);line-height:1;filter:drop-shadow(0 0 12px #55dfff);transform:translate(-50%,-50%) rotate(-18deg);transition:left .1s linear,top .1s linear}.ta-crash-box{background:#0b1726;border:1px solid #1d354b;border-radius:14px;padding:14px;min-width:0}.ta-crash-box small{display:block;color:#89a5bc;font-size:11px;letter-spacing:.8px;margin-bottom:8px}.ta-crash-box strong{font-size:20px}.ta-crash-input{width:100%;margin-top:10px;background:#06101c;border:1px solid #29445e;border-radius:9px;padding:12px;color:white}.ta-crash-action{width:100%;margin-top:12px;border:0;border-radius:10px;padding:14px;font-weight:900;color:#05131e;background:linear-gradient(135deg,#7eeaff,#36b8ff);cursor:pointer}.ta-crash-action.out{background:linear-gradient(135deg,#b6ffda,#42df9b)}.ta-crash-action:disabled{opacity:.45;cursor:not-allowed}.ta-crash-columns{display:grid;grid-template-columns:minmax(0,1.6fr) minmax(250px,1fr);gap:14px}.ta-crash-playerlist{background:#091522;border:1px solid #1b354b;border-radius:16px;padding:14px;min-width:0}.ta-crash-player{display:flex;justify-content:space-between;gap:12px;padding:11px 4px;border-bottom:1px solid #152a3d;font-size:13px}.ta-crash-player:last-child{border-bottom:0}.ta-crash-note{color:#8ba7bd;font-size:12px;margin-top:14px}.ta-crash-betgrid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin-top:14px}.ta-crash-panelhead{display:flex;justify-content:space-between;gap:8px;margin-bottom:14px;color:#8deaff}.ta-crash-panelhead span{font-size:10px;color:#8daec7}.ta-crash-panel-return{margin-top:14px;padding-top:12px;border-top:1px solid #1b354b}.ta-crash-panel-return strong{display:block}.ta-crash-history{display:flex;gap:8px;overflow:auto;padding:12px 0}.ta-crash-history span{flex:0 0 auto;background:#102438;border:1px solid #28445c;border-radius:9px;padding:8px 12px;font-weight:800;color:#8deaff}.ta-crash-stats{display:grid;grid-template-columns:repeat(3,1fr);gap:9px;margin:12px 0}.ta-crash-stat{background:#091522;border:1px solid #1b354b;border-radius:12px;padding:12px}.ta-crash-stat small{display:block;color:#8caac2;font-size:10px}.ta-crash-stat b{display:block;margin-top:6px;font-size:18px}.ta-crash-tabs{display:flex;gap:6px;margin:8px 0 12px}.ta-crash-tabs button,.ta-crash-quick button{background:#102438;border:1px solid #28445c;color:#a9cce1;padding:8px 11px;border-radius:8px;font-weight:700}.ta-crash-tabs button.active{background:#144a61;color:#fff;border-color:#46c8e9}.ta-crash-quick{display:flex;gap:7px;margin-top:8px}.ta-crash-quick button{flex:1;cursor:pointer}.ta-chat-list{max-height:210px;overflow:auto}.ta-chat-row{padding:8px 0;border-bottom:1px solid #172b3b;font-size:12px;overflow-wrap:anywhere}.ta-chat-row b{color:#8deaff;margin-right:6px}.ta-chat-form{display:flex;gap:7px;margin-top:10px}.ta-chat-form input{min-width:0;flex:1;background:#06101c;border:1px solid #29445e;border-radius:8px;padding:10px;color:#fff}.ta-chat-form button{background:#35c6e7;color:#04111a;border-radius:8px;padding:0 12px;font-weight:800}@media(max-width:760px){.ta-crash-columns{grid-template-columns:1fr}.ta-crash-betgrid{grid-template-columns:1fr}.ta-crash-stats{grid-template-columns:repeat(3,minmax(0,1fr))}.ta-crash-stat{padding:9px}.ta-crash-stat b{font-size:14px}}`}</style>
    <div className="ta-crash-top"><div><div className="ta-crash-brand">TA777 GAMING</div><h1 style={{margin:"6px 0 0"}}>Crash</h1><div style={{color:"#8caac2",fontSize:13}}>One shared live round • Two independent manual bets</div></div><div className="ta-crash-audio"><button type="button" className={"ta-crash-audio-btn "+(musicOn?"on":"")} onClick={toggleMusic} aria-pressed={musicOn}>♫ Music {musicOn?"ON":"OFF"}</button><button type="button" className={"ta-crash-audio-btn "+(effectsOn?"on":"")} onClick={toggleEffects} aria-pressed={effectsOn}>🔊 Effects {effectsOn?"ON":"OFF"}</button><label>Music <input aria-label="Music volume" type="range" min="0" max="100" value={musicVolume} onChange={e=>changeMusicVolume(e.target.value)}/></label><label>Effects <input aria-label="Sound effects volume" type="range" min="0" max="100" value={effectsVolume} onChange={e=>changeEffectsVolume(e.target.value)}/></label><span className="ta-crash-pill">● LIVE ROUND&nbsp; #{String(round?.id||"—").slice(0,8)}</span></div></div>
    {error&&<div className="error">{error}</div>}{message&&<div className="success">{message}</div>}
    <div className="ta-crash-history"><b style={{alignSelf:"center",color:"#8caac2",whiteSpace:"nowrap"}}>RECENT</b>{history.length?history.slice(0,30).map((h,i)=><span key={h.id||i} style={{color:h.multiplier>=2?"#75ffc3":h.multiplier<1.5?"#ff9bb5":"#8deaff"}}>{h.multiplier.toFixed(2)}×</span>):<span>No completed rounds yet</span>}</div>
    <div className="ta-crash-board"><div className="ta-crash-state">{round?.status?.toUpperCase()||"CONNECTING"} · SHARED ROUND</div><div className="ta-crash-mult">{multiplier.toFixed(2)}×</div><div className="ta-crash-road" aria-hidden="true"/><div className={"ta-crash-car "+(String(round?.status).toLowerCase()==="blasted"?"is-crashed":"")} style={{left:`${carX}%`,top:`${carY}%`}} aria-label="Car driving on the road"><span className="ta-car-emoji">🏎️</span><span className="ta-car-flame">»»</span></div></div>
    <div className="ta-crash-stats"><div className="ta-crash-stat"><small>PLAYERS / BETS</small><b>{new Set(players.map(p=>p.user_id)).size} / {players.length}</b></div><div className="ta-crash-stat"><small>TOTAL STAKED</small><b>{totalStake.toLocaleString()} TA</b></div><div className="ta-crash-stat"><small>TOP CASHOUT</small><b>{topWin?`${topWin.cashout.toFixed(2)}×`:"—"}</b></div></div>
    <div className="ta-crash-betgrid">{panelCard(0)}{panelCard(1)}</div>
    <div className="ta-crash-columns" style={{marginTop:14}}><aside className="ta-crash-playerlist"><h3 style={{margin:"2px 0 10px"}}>● Bets & players <span style={{float:"right",color:"#8deaff"}}>{players.length}</span></h3><div className="ta-crash-tabs"><button className={tab==="all"?"active":""} onClick={()=>setTab("all")}>All Bets</button><button className={tab==="mine"?"active":""} onClick={()=>setTab("mine")}>My Bets</button><button className={tab==="top"?"active":""} onClick={()=>setTab("top")}>Top Wins</button></div>{(tab==="top"?[...visible].sort((a,b)=>b.payout-a.payout):visible).length===0?<div style={{color:"#8caac2",padding:"16px 0"}}>No bets to show for this round.</div>:(tab==="top"?[...visible].sort((a,b)=>b.payout-a.payout):visible).map((p,i)=><div className="ta-crash-player" key={String(p.id)+i}><div><b>{p.name} · Bet {p.panel}</b><div style={{color:"#8caac2",marginTop:4}}>{p.amount.toLocaleString()} TA {p.status==="cashed_out"?`· ${p.cashout.toFixed(2)}×`:""}</div></div><span style={{color:p.status==="cashed_out"?"#7dffbd":p.status==="lost"?"#ff7796":"#8deaff"}}>{p.status==="cashed_out"?`${p.payout.toLocaleString()} TA`:p.status.toUpperCase()}</span></div>)}</aside>
    <aside className="ta-crash-playerlist"><h3 style={{margin:"2px 0 10px"}}>● Round chat</h3><div className="ta-chat-list">{chat.length?chat.map(c=><div className="ta-chat-row" key={c.id}><b>{c.user_id===user?.id?"You":(players.find(p=>p.user_id===c.user_id)?.name||"Player")}</b>{c.message}</div>):<div style={{color:"#8caac2",padding:"10px 0"}}>No messages yet.</div>}</div><form className="ta-chat-form" onSubmit={sendChat}><input value={chatText} onChange={e=>setChatText(e.target.value)} maxLength={300} placeholder="Write a message…" aria-label="Chat message"/><button type="submit" disabled={!chatText.trim()}>Send</button></form></aside></div>
    <div className="ta-crash-note">Manual play only. No Auto Bet or Auto Cash Out. All players share one round and crash point; each panel is settled separately. Past round results do not predict future outcomes.</div>
  </section>;
}
function useParamsSafe(){const location=useLocation();const parts=location.pathname.split("/").filter(Boolean);return {planId:parts[1]||""};}

/* =========================================================
   CUSTOMER DASHBOARD
========================================================= */


function formatCountdown(ms){
  const safe=Math.max(0,Math.floor(ms/1000));
  const hours=Math.floor(safe/3600);
  const minutes=Math.floor((safe%3600)/60);
  const seconds=safe%60;
  return [hours,minutes,seconds].map(n=>String(n).padStart(2,"0")).join(":");
}

function getPlanDailyRate(planOrItem){
  const raw=Number(planOrItem?.daily_earning_rate ?? planOrItem?.plans?.daily_earning_rate);
  return Number.isFinite(raw)&&raw>=0 ? raw/100 : DEFAULT_DAILY_EARNING_RATE;
}

function earningPerCycle(item){
  return Number((Number(item.price_paid??item.plans?.price??0)*getPlanDailyRate(item)).toFixed(2));
}

function totalPlanProfit(plan){
  const price=Number(plan?.price||0);
  const duration=Math.max(0,Number(plan?.duration_days||0));
  return Number((price*getPlanDailyRate(plan)*duration).toFixed(2));
}

function earningsStorageKey(userId){
  return `${EARNINGS_STORAGE_PREFIX}${userId}`;
}

function readCustomerEarnings(userId){
  try{
    const raw=localStorage.getItem(earningsStorageKey(userId));
    return raw?JSON.parse(raw):{};
  }catch{return {};}
}

function writeCustomerEarnings(userId,value){
  try{localStorage.setItem(earningsStorageKey(userId),JSON.stringify(value));}catch{}
}

function customerProfileSeenKey(userId){
  return `${CUSTOMER_PROFILE_SEEN_PREFIX}${userId}`;
}

function readSeenProfileUpdatedAt(userId){
  try{return localStorage.getItem(customerProfileSeenKey(userId))||"";}catch{return "";}
}

function writeSeenProfileUpdatedAt(userId,value){
  try{localStorage.setItem(customerProfileSeenKey(userId),String(value||""));}catch{}
}

function Dashboard({ user, profile }) {
  const [copied,setCopied]=useState(false);
  const [customerPlans,setCustomerPlans]=useState([]);
  const [availablePlans,setAvailablePlans]=useState([]);
  const [customerPayments,setCustomerPayments]=useState([]);
  const [withdrawals,setWithdrawals]=useState([]);
  const [walletDepositReference,setWalletDepositReference]=useState("");
  const [walletDepositSlip,setWalletDepositSlip]=useState(null);
  const [walletDepositPreview,setWalletDepositPreview]=useState("");
  const [walletDepositMethods,setWalletDepositMethods]=useState([]);
  const [walletDepositMethod,setWalletDepositMethod]=useState(null);
  const [walletDepositSubmitting,setWalletDepositSubmitting]=useState(false);
  const [walletDepositMessage,setWalletDepositMessage]=useState("");
  const [walletDepositError,setWalletDepositError]=useState("");
  const [remoteWalletBalance,setRemoteWalletBalance]=useState(0);
  const [acWithdrawalBalance,setAcWithdrawalBalance]=useState(0);
  const [withdrawalLocked,setWithdrawalLocked]=useState(false);
  const [loadingPlans,setLoadingPlans]=useState(true);
  const [withdrawalAmount,setWithdrawalAmount]=useState("");
  const [withdrawalAccountName,setWithdrawalAccountName]=useState("");
  const [withdrawalAccountHolder,setWithdrawalAccountHolder]=useState("");
  const [withdrawalAccountNumber,setWithdrawalAccountNumber]=useState("");
  const [withdrawalSubmitting,setWithdrawalSubmitting]=useState(false);
  const [withdrawalMessage,setWithdrawalMessage]=useState("");
  const [withdrawalError,setWithdrawalError]=useState("");
  const [withdrawalUnlocks,setWithdrawalUnlocks]=useState({tracked:false,qualifying:[],usedCount:0,available:[],availableLimit:0});
  const [plansError,setPlansError]=useState("");
  const [earnings,setEarnings]=useState({});
  const [clock,setClock]=useState(Date.now());
  const [collecting,setCollecting]=useState(null);
  const [collectMessage,setCollectMessage]=useState("");
  const [referralSettings,setReferralSettings]=useState(getReferralSettings());
  const [referrerProfile,setReferrerProfile]=useState(null);
  const [accountPanel,setAccountPanel]=useState(null);

  const referralCode=profile?.referral_code||user?.id?.slice(0,8).toUpperCase()||"USER";
  const referral=`${window.location.origin}/register?ref=${referralCode}`;

  async function loadReferrerProfile(){
    if(!user?.id){setReferrerProfile(null);return;}
    try{
      // Current TA777Gaming schema uses profiles.referred_by. The lookup is
      // performed through a SECURITY DEFINER RPC when possible because normal
      // customer RLS hides other customer profiles.
      if(profile?.referred_by){
        const r=await supabase.rpc("rh_get_referrer_profile",{p_customer_id:user.id});
        if(!r.error && r.data){setReferrerProfile(Array.isArray(r.data)?r.data[0]||null:r.data);return;}
        const direct=await supabase.from("profiles").select("id,full_name,email,referral_code").eq("id",profile.referred_by).maybeSingle();
        if(!direct.error){setReferrerProfile(direct.data||null);return;}
      }
      setReferrerProfile(null);
    }catch{setReferrerProfile(null);}
  }

  async function loadCustomerPlans(){
    setLoadingPlans(true);setPlansError("");
    let result=await supabase.from("customer_plans").select("id,customer_id,plan_id,payment_request_id,price_paid,starts_at,ends_at,status,created_at,plans(name,price,duration_days,daily_earning_rate,referral_commission)").eq("customer_id",user.id).order("created_at",{ascending:false});
    if(result.error && /payment_request_id|column/i.test(result.error.message||"")){
      result=await supabase.from("customer_plans").select("id,customer_id,plan_id,price_paid,starts_at,ends_at,status,created_at,plans(name,price,duration_days,daily_earning_rate,referral_commission)").eq("customer_id",user.id).order("created_at",{ascending:false});
    }
    if(result.error && /daily_earning_rate|column/i.test(result.error.message||"")){
      result=await supabase.from("customer_plans").select("id,customer_id,plan_id,price_paid,starts_at,ends_at,status,created_at,plans(name,price,duration_days,referral_commission)").eq("customer_id",user.id).order("created_at",{ascending:false});
    }
    const {data,error}=result;
    if(error){setPlansError(error.message);setCustomerPlans([]);}else setCustomerPlans(data||[]);
    setLoadingPlans(false);
  }

  async function loadAvailablePlans(){
    try{
      let result=await supabase.from("plans").select("id,name,description,price,daily_earning_rate,duration_days,referral_commission,status").eq("status","active").order("name",{ascending:true});
      if(result.error && /daily_earning_rate|column/i.test(result.error.message||"")){
        result=await supabase.from("plans").select("id,name,description,price,duration_days,referral_commission,status").eq("status","active").order("name",{ascending:true});
      }
      if(!result.error)setAvailablePlans(sortPlans(result.data||[]));
    }catch{}
  }

  async function loadCustomerPayments(){
    const {data,error}=await supabase.from("payments").select("id,user_id,status,amount,transaction_reference,created_at,payment_type").eq("user_id",user.id).order("created_at",{ascending:false});
    if(!error)setCustomerPayments(data||[]);
  }

  async function loadWalletDepositData(){
    try{const {data,error}=await supabase.from("payment_methods").select("*").eq("is_active",true).order("created_at",{ascending:true});if(!error){setWalletDepositMethods(data||[]);setWalletDepositMethod(data?.[0]||null);}}catch{}
    // The customer dashboard uses the same shared AC wallet as games and AC withdrawals.
    try{
      const {data:acWallet,error:acWalletError}=await supabase.from("ac_game_wallets").select("balance").eq("user_id",user.id).maybeSingle();
      if(!acWalletError)setAcWithdrawalBalance(Number(acWallet?.balance||0));
    }catch{}
    try{const {data:p}=await supabase.from("profiles").select("withdrawal_locked").eq("id",user.id).maybeSingle();if(p&&typeof p.withdrawal_locked!=="undefined")setWithdrawalLocked(Boolean(p.withdrawal_locked));else setWithdrawalLocked(localStorage.getItem(`rh_withdrawal_locked_${user.id}`)==="1");}catch{}
  }
  function chooseWalletDepositSlip(file){setWalletDepositError("");if(!file){setWalletDepositSlip(null);setWalletDepositPreview("");return;}if(!file.type.startsWith("image/")){setWalletDepositError("Deposit slip must be an image file.");return;}if(file.size>MAX_SLIP_SIZE){setWalletDepositError("Deposit slip must be 5 MB or smaller.");return;}setWalletDepositSlip(file);setWalletDepositPreview(URL.createObjectURL(file));}
  async function submitWalletDeposit(e){
    e.preventDefault();setWalletDepositError("");setWalletDepositMessage("");
    if(!walletDepositMethod){setWalletDepositError("Select a payment method.");return;}if(!walletDepositReference.trim()){setWalletDepositError("Enter your transaction/reference number.");return;}if(!walletDepositSlip){setWalletDepositError("Upload your deposit payment slip.");return;}
    setWalletDepositSubmitting(true);
    try{const ext=(walletDepositSlip.name.split(".").pop()||"jpg").toLowerCase().replace(/[^a-z0-9]/g,"")||"jpg";const path=`${user.id}/wallet-${crypto.randomUUID()}.${ext}`;const up=await supabase.storage.from(PAYMENT_SLIP_BUCKET).upload(path,walletDepositSlip,{contentType:walletDepositSlip.type,upsert:false});if(up.error)throw new Error(`Deposit slip upload failed: ${up.error.message}`);
      // Wallet deposits are not plan purchases. Do not look up or attach an active
      // plan; keep this payment explicitly marked as a wallet_deposit.
      // This requires payments.plan_id to allow NULL in the database schema.
      let payload={user_id:user.id,payment_method_id:walletDepositMethod.id,amount:50,transaction_reference:walletDepositReference.trim(),payment_slip_path:path,status:"pending",payment_type:"wallet_deposit"};
      let ins=await supabase.from("payments").insert(payload);
      if(ins.error&&/payment_type|column/i.test(ins.error.message||"")){
        // Older schemas may not have payment_type. Keep a marker in the reference so
        // the admin approval path can still identify this as a wallet deposit.
        payload.transaction_reference=`WALLET_DEPOSIT:${walletDepositReference.trim()}`;delete payload.payment_type;ins=await supabase.from("payments").insert(payload);
      }
      if(ins.error){await supabase.storage.from(PAYMENT_SLIP_BUCKET).remove([path]);throw ins.error;}setWalletDepositReference("");setWalletDepositSlip(null);setWalletDepositPreview("");setWalletDepositMessage("Deposit submitted successfully. The administrator will review your payment slip.");await loadCustomerPayments();}catch(err){setWalletDepositError(err?.message||"Could not submit deposit.");}finally{setWalletDepositSubmitting(false);}
  }

  async function loadWithdrawals(){
    const r=await supabase.from("ac_withdrawal_requests").select("*").eq("user_id",user.id).order("created_at",{ascending:false});
    if(!r.error){setWithdrawals(r.data||[]);return r.data||[];}
    setWithdrawalError("AC withdrawal service is not installed yet. Apply the supplied SQL migration.");
    return [];
  }

  async function loadAcWithdrawalBalance(){
    if(!user?.id)return 0;
    try{
      const {data,error}=await supabase.from("ac_game_wallets").select("balance").eq("user_id",user.id).maybeSingle();
      if(error)throw error;
      const balance=Number(data?.balance||0);
      setAcWithdrawalBalance(balance);
      return balance;
    }catch(error){
      console.error("Could not load shared AC wallet balance:",error?.message||error);
      return null;
    }
  }

  async function loadWithdrawalUnlockData(currentWithdrawals=null){
    const ws=currentWithdrawals||withdrawals;
    const info=await getWithdrawalUnlocks(user.id,ws);
    setWithdrawalUnlocks(info);
    return info;
  }

  useEffect(()=>{
    if(!user)return;

    const currentUpdatedAt=profile?.updated_at||"";
    const seenUpdatedAt=readSeenProfileUpdatedAt(user.id);
    if(!seenUpdatedAt)writeSeenProfileUpdatedAt(user.id,currentUpdatedAt);
    setEarnings(readCustomerEarnings(user.id));
    loadReferrerProfile();

    loadCustomerPlans();
    loadAvailablePlans();
    loadCustomerPayments();
    loadWithdrawals().then((latest)=>{loadWithdrawalUnlockData(latest||[]);loadAcWithdrawalBalance();});
    loadWalletDepositData();

    const timer=setInterval(()=>setClock(Date.now()),1000);
    const refresh=setInterval(async()=>{
      loadReferrerProfile();
      loadCustomerPlans();
      loadAvailablePlans();
      loadCustomerPayments();
      loadWithdrawals().then((latest)=>{loadWithdrawalUnlockData(latest||[]);loadAcWithdrawalBalance();});

      // Admin reset signal: profiles.updated_at changes when the customer's
      // transactional data is reset. Clear locally stored earning/wallet data.
      try{
        const {data:latestProfile}=await supabase.from("profiles").select("updated_at").eq("id",user.id).maybeSingle();
        const latestUpdatedAt=latestProfile?.updated_at||"";
        const seen=readSeenProfileUpdatedAt(user.id);
        if(latestUpdatedAt && seen && latestUpdatedAt!==seen){
          try{localStorage.removeItem(earningsStorageKey(user.id));}catch{}
          for(const plan of customerPlans){clearInitialEarningCredit(user.id,plan.id);}
          writeSeenProfileUpdatedAt(user.id,latestUpdatedAt);
          setEarnings({});
          setCollectMessage("");
          setWithdrawalMessage("");
          setWithdrawalError("");
        }else if(latestUpdatedAt && !seen){
          writeSeenProfileUpdatedAt(user.id,latestUpdatedAt);
        }
      }catch{}
    },10000);

    return()=>{clearInterval(timer);clearInterval(refresh);};
  },[user?.id,profile?.updated_at]);

  // FIRST EARNING FIX:
  // Every approved active plan gets exactly one immediate first earning.
  // The durable transaction ledger is the idempotency source of truth, so an
  // old browser localStorage value can never prevent a missing first payment.
  useEffect(()=>{
    if(!user||customerPlans.length===0)return;
    let cancelled=false;

    async function creditMissingInitialEarnings(){
      const stored=readCustomerEarnings(user.id);
      const active=customerPlans.filter(item=>item.status==="active");

      for(const item of active){
        if(cancelled)break;
        if(initialEarningCreditInFlight.has(item.id))continue;

        const daily=earningPerCycle(item);
        if(!Number.isFinite(daily)||daily<=0)continue;

        const sourceKey=`INITIAL_EARNING:${item.id}`;
        let alreadyCredited=false;
        try{
          const tx=await supabase.from("customer_wallet_transactions")
            .select("id")
            .eq("customer_id",user.id)
            .eq("source_key",sourceKey)
            .limit(1)
            .maybeSingle();
          if(!tx.error && tx.data?.id)alreadyCredited=true;
        }catch{}

        if(alreadyCredited){
          if(!initialEarningWasCredited(user.id,item.id))markInitialEarningCredited(user.id,item.id);
          continue;
        }

        initialEarningCreditInFlight.add(item.id);
        walletWriteInFlight.add(user.id);
        try{
          const walletUpdated=await incrementPersistentWalletBalance(user.id,daily,{
            sourceKey,
            sourceId:item.id,
            transactionType:"earning",
            description:`First ${Number(item.plans?.daily_earning_rate??10)}% earning from ${item.plans?.name||"plan"}`
          });

          if(!walletUpdated){
            // Keep the first earning visible locally while the durable wallet is
            // unavailable. Do not mark it as credited; the next successful
            // sync will attempt the same INITIAL_EARNING source key again.
            const createdAt=new Date().toISOString();
            const latest=readCustomerEarnings(user.id);
            if(!latest[item.id]){
              latest[item.id]={balance:daily,totalEarned:daily,cycleStartedAt:item.starts_at||createdAt,cyclesCollected:1,createdForPlanAt:createdAt};
              writeCustomerEarnings(user.id,latest);
              if(!cancelled)setEarnings(latest);
            }
            if(!cancelled){
              setRemoteWalletBalance(await readRemoteWalletBalance(user.id));
              setCollectMessage(`First ${Number(item.plans?.daily_earning_rate??10)}% earning of Rs ${daily.toLocaleString()} is ready and will be synchronized to your wallet.`);
            }
            continue;
          }

          const createdAt=new Date().toISOString();
          const existingState=stored[item.id];
          const earningState=existingState||{
            balance:daily,
            totalEarned:daily,
            cycleStartedAt:item.starts_at||createdAt,
            cyclesCollected:1,
            createdForPlanAt:createdAt
          };
          const latest=readCustomerEarnings(user.id);
          if(!latest[item.id]){
            const next={...latest,[item.id]:earningState};
            writeCustomerEarnings(user.id,next);
            if(!cancelled)setEarnings(next);
          }

          const verifiedBalance=await readRemoteWalletBalance(user.id);
          if(!cancelled)setRemoteWalletBalance(verifiedBalance);
          markInitialEarningCredited(user.id,item.id);
          if(!cancelled)setCollectMessage(`First ${Number(item.plans?.daily_earning_rate??10)}% earning of Rs ${daily.toLocaleString()} has been added to your wallet.`);
        }catch(err){
          console.warn("Initial earning credit failed:",err);
          if(!cancelled)setCollectMessage("Your first earning could not be added to the wallet yet. Please refresh or contact the administrator.");
        }finally{
          initialEarningCreditInFlight.delete(item.id);
          walletWriteInFlight.delete(user.id);
        }
      }
    }

    creditMissingInitialEarnings();
    return()=>{cancelled=true;};
  },[user?.id,customerPlans]);

  async function copy(){
    try{
      await navigator.clipboard.writeText(referral);
      setCopied(true);
      setTimeout(()=>setCopied(false),1500);
    }catch{}
  }

  async function collectEarning(item){
    const daily=earningPerCycle(item);
    const state=earnings[item.id];

    if(!state||item.status!=="active")return;

    const cycleStarted=new Date(state.cycleStartedAt||item.starts_at).getTime();
    const elapsed=clock-cycleStarted;

    if(elapsed<EARNING_INTERVAL_MS){
      setCollectMessage("Your 24-hour earning timer has not finished yet.");
      setTimeout(()=>setCollectMessage(""),2500);
      return;
    }

    if(item.ends_at&&clock>=new Date(item.ends_at).getTime()){
      setCollectMessage("This plan has ended. No further daily earning can be collected.");
      setTimeout(()=>setCollectMessage(""),3000);
      return;
    }

    setCollecting(item.id);
    setCollectMessage("");

    try{
      const nextState={
        ...state,
        balance:Number((Number(state.balance||0)+daily).toFixed(2)),
        totalEarned:Number((Number(state.totalEarned||0)+daily).toFixed(2)),
        cycleStartedAt:new Date().toISOString(),
        cyclesCollected:Number(state.cyclesCollected||0)+1
      };

      const nextEarnings={...earnings,[item.id]:nextState};
      const walletUpdated=await incrementPersistentWalletBalance(user.id,daily,{sourceKey:`EARNING:${item.id}:${nextState.cyclesCollected}`,sourceId:item.id,transactionType:"earning",description:`Daily earning from ${item.plans?.name||"plan"}`});
      if(!walletUpdated)throw new Error("Earning could not be added to your wallet. Please try again or contact the administrator.");
      writeCustomerEarnings(user.id,nextEarnings);
      setEarnings(nextEarnings);
      setCollectMessage(`Rs ${daily.toLocaleString()} collected successfully. Your next 24-hour timer has started.`);
      setTimeout(()=>setCollectMessage(""),3500);
    }finally{
      setCollecting(null);
    }
  }

  async function submitWithdrawal(e){
    e.preventDefault();setWithdrawalError("");setWithdrawalMessage("");
    const amount=Number(withdrawalAmount);
    const method=withdrawalAccountName.trim(), holder=withdrawalAccountHolder.trim(), account=withdrawalAccountNumber.trim();
    if(!Number.isInteger(amount)||amount<500||amount>50000){setWithdrawalError("Withdrawal must be from 500 to 50,000 AC.");return;}
    if(!method||!holder||!account){setWithdrawalError("Enter payment method, account holder name and account number.");return;}
    setWithdrawalSubmitting(true);
    try{
      const {data:wallet,error:walletError}=await supabase.from("ac_game_wallets").select("balance").eq("user_id",user.id).maybeSingle();
      if(walletError)throw walletError;
      const balance=Number(wallet?.balance||0);
      const pending=withdrawals.filter(w=>w.status==="pending").reduce((sum,w)=>sum+Number(w.amount||0),0);
      if(amount>Math.max(0,balance-pending))throw new Error(`Insufficient AC balance. Available: ${Math.max(0,balance-pending).toLocaleString()} AC.`);
      const {error}=await supabase.from("ac_withdrawal_requests").insert({user_id:user.id,amount,payment_method:method,account_holder:holder,account_number:account,status:"pending"});
      if(error)throw error;
      setWithdrawalAmount("");setWithdrawalAccountName("");setWithdrawalAccountHolder("");setWithdrawalAccountNumber("");
      setWithdrawalMessage("AC withdrawal request sent. AC will be deducted only after admin approval.");await loadWithdrawals();
    }catch(err){setWithdrawalError(err?.message||"Could not submit AC withdrawal request.");}
    finally{setWithdrawalSubmitting(false);}
  }


  const activePlans=customerPlans.filter(item=>item.status==="active");
  const activePlan=activePlans[0]||null;
  // remoteWalletBalance is the durable TA777Gaming wallet and therefore the
  // single source of truth for the displayed current balance.
  const earnedWallet=Number(Object.values(earnings).reduce((sum,item)=>sum+Number(item.balance||0),0).toFixed(2));
  // A legacy first-earning record may exist locally while the old version never
  // wrote it to the durable wallet. Show that missing first earning immediately
  // instead of displaying Rs 0. Once the durable wallet/ledger contains the
  // INITIAL_EARNING transaction, it is not added a second time.
  const locallyTrackedInitial=Number(Object.entries(earnings).reduce((sum,[planId,state])=>{
    return sum + (initialEarningWasCredited(user?.id,planId) ? 0 : Number(state?.balance||0));
  },0).toFixed(2));
  const totalBalance=Number(Math.max(0,remoteWalletBalance+locallyTrackedInitial).toFixed(2));
  const totalEarned=Number(Object.values(earnings).reduce((sum,item)=>sum+Number(item.totalEarned||0),0).toFixed(2));
  // The wallet balance returned by Supabase is already the current/net balance.
  // Approved withdrawals have already been debited by the secure database trigger,
  // so subtracting approved withdrawals here would double-count them and can make
  // the withdrawal section show Rs 0 while the dashboard correctly shows a balance.
  // Only pending requests are reserved from the currently available balance.
  const pendingWithdrawalAmount=withdrawals.filter(w=>w.status==="pending").reduce((sum,w)=>sum+Number(w.amount||0),0);
  const availableWithdrawalBalance=Math.max(0,Number(acWithdrawalBalance||0)-pendingWithdrawalAmount);
  const amount=Number(withdrawalAmount)||0;

  const paymentById=Object.fromEntries(customerPayments.map(item=>[item.id,item]));
  const planViews=customerPlans.map(item=>{
    const state=earnings[item.id];
    const daily=earningPerCycle(item);
    const cycleStarted=state?.cycleStartedAt?new Date(state.cycleStartedAt).getTime():new Date(item.starts_at||clock).getTime();
    const remaining=Math.max(0,EARNING_INTERVAL_MS-(clock-cycleStarted));
    const canCollect=item.status==="active"&&remaining===0&&(!item.ends_at||clock<new Date(item.ends_at).getTime());
    const durationDays=Math.max(1,Number(item.plans?.duration_days||45));
    const elapsedFromStart=Math.max(0,clock-new Date(item.starts_at||clock).getTime());
    const durationProgress=Math.min(100,(elapsedFromStart/(durationDays*EARNING_INTERVAL_MS))*100);
    return {...item,state,daily,remaining,canCollect,durationProgress,payment:paymentById[item.payment_request_id]};
  });

  return <section className="page-section">
    <PremiumProfile user={user} profile={profile} referrerProfile={referrerProfile} stats={[{label:"AC balance",value:`${Number(acWithdrawalBalance||0).toLocaleString()} AC`}]} />

    <div className="dashboard-head">
      <div><span className="eyebrow">CUSTOMER DASHBOARD</span><h1>Welcome back</h1><p className="muted">Play Graph Game or Horse Racing, deposit funds and manage withdrawals.</p></div>
      <span className="status">TA GAMES LIVE</span>
    </div>

    {collectMessage&&<div className="success">{collectMessage}</div>}



    <div className="dashboard-card ta-actions-card">
      <span className="eyebrow">ACCOUNT SERVICES</span>
      <h2>Cash In & Withdrawal</h2>
      <p className="muted">Use the separate buttons below to open the deposit or withdrawal request form.</p>
      <div className="hero-actions">
        <button type="button" className="btn primary" onClick={()=>setAccountPanel("deposit")}>💳 CASH IN</button>
        <button type="button" className="btn secondary" onClick={()=>setAccountPanel("withdrawal")}>💸 WITHDRAWAL</button>
      </div>
      <div className="notice"><strong>Cash In minimum: 50 AC.</strong> Deposits, game play, and withdrawals use your shared AC balance.</div>
    </div>

    <div className="dashboard-card ta-game-center-shortcut"><span className="eyebrow">LIVE GAMES</span><h2>Graph Game & Horse Racing</h2><p className="muted">Open the game center to join a live round using AC tokens.</p><Link className="btn primary" to="/games">Open Game Center <ArrowRight size={18}/></Link></div>
{accountPanel === "deposit" && <div className="ta-service-modal" onClick={()=>setAccountPanel(null)}>
  <div className="dashboard-card ta-service-panel" onClick={e=>e.stopPropagation()}>
    <div className="service-head"><div><span className="eyebrow">CASH IN</span><h2>Deposit / Cash In</h2><p className="muted">Minimum cash in: <strong>50 AC</strong>. Enter your payment proof only. The administrator sets the AC amount before approval.</p></div><button type="button" className="text-btn" onClick={()=>setAccountPanel(null)}>Close ✕</button></div>
    {walletDepositError&&<div className="error">{walletDepositError}</div>}
    {walletDepositMessage&&<div className="success">{walletDepositMessage}</div>}
    <form onSubmit={submitWalletDeposit}>
      <label>Payment method<select value={walletDepositMethod?.id||""} onChange={e=>setWalletDepositMethod(walletDepositMethods.find(m=>m.id===e.target.value)||null)} required><option value="">Select payment method</option>{walletDepositMethods.map(m=><option key={m.id} value={m.id}>{m.name} — {m.account_number||m.account_name||""}</option>)}</select></label>
      {walletDepositMethod&&<div className="ta-payment-box"><strong>{walletDepositMethod.name}</strong><p>{walletDepositMethod.account_name||"Account"} · {walletDepositMethod.account_number||"—"}</p><small>{walletDepositMethod.instructions||"Send payment and upload the proof below."}</small></div>}
      <label>Transaction / reference number<input type="text" value={walletDepositReference} onChange={e=>setWalletDepositReference(e.target.value)} placeholder="Enter transaction ID" required/></label>
      <label>Payment slip<input type="file" accept="image/*" onChange={e=>chooseWalletDepositSlip(e.target.files?.[0]||null)} required/></label>
      {walletDepositPreview&&<img className="ta-slip-preview" src={walletDepositPreview} alt="Deposit slip preview"/>}
      <button className="btn primary full" type="submit" disabled={walletDepositSubmitting||!walletDepositMethods.length}>{walletDepositSubmitting?"Sending cash in...":"Send Cash In Request"}</button>
    </form>
  </div>
</div>}

{accountPanel === "withdrawal" && <div className="ta-service-modal" onClick={()=>setAccountPanel(null)}>
  <div className="dashboard-card ta-service-panel" onClick={e=>e.stopPropagation()}>
    <div className="service-head"><div><span className="eyebrow">WITHDRAWAL</span><h2>Withdrawal Request</h2><p className="muted">Minimum: <strong>500 AC</strong> · Maximum: <strong>50,000 AC</strong>.</p></div><button type="button" className="text-btn" onClick={()=>setAccountPanel(null)}>Close ✕</button></div>
    <div className="notice"><strong>Available balance: AC {availableWithdrawalBalance.toLocaleString()}</strong><p>No fee or commission. AC is deducted only after admin approval.</p></div>
    {withdrawalError&&<div className="error">{withdrawalError}</div>}{withdrawalMessage&&<div className="success">{withdrawalMessage}</div>}
    <form onSubmit={submitWithdrawal}>
      <label>Payment account name<input type="text" value={withdrawalAccountName} onChange={e=>setWithdrawalAccountName(e.target.value)} placeholder="JazzCash / Easypaisa / Bank" required/></label>
      <label>Account holder name<input type="text" value={withdrawalAccountHolder} onChange={e=>setWithdrawalAccountHolder(e.target.value)} placeholder="Enter account holder name" required/></label>
      <label>Account number<input type="text" inputMode="numeric" value={withdrawalAccountNumber} onChange={e=>setWithdrawalAccountNumber(e.target.value)} placeholder="Enter account number" required/></label>
      <label>Withdrawal amount (AC)<input type="number" min="500" max={Math.min(50000,availableWithdrawalBalance)} step="1" value={withdrawalAmount} onChange={e=>setWithdrawalAmount(e.target.value)} placeholder="500 - 50000 AC" required/></label>
      <button className="btn primary full" type="submit" disabled={withdrawalSubmitting||availableWithdrawalBalance<500}>{withdrawalSubmitting?"Sending...":availableWithdrawalBalance<500?"Minimum 500 AC Required":"Request Withdrawal"}</button>
    </form>
    <div className="dashboard-card" style={{marginTop:16}}><span className="eyebrow">WITHDRAWAL HISTORY</span><h2>Your requests</h2>{withdrawals.length===0?<div className="rh-empty">No withdrawal requests yet.</div>:withdrawals.map(item=>{const details=decodeWithdrawalAccountDetails(item);return <div className="admin-list-item" key={item.id}><div><strong>{Number(item.amount||0).toLocaleString()} AC</strong><p className="muted">Payment method: {item.payment_method||details.method||"—"}</p><p className="muted">Account holder: {item.account_holder||details.holderName||"—"}</p><p className="muted">Account number: {item.account_number||details.accountNumber||"—"}</p></div><span className={item.status==="approved"?"status":item.status==="rejected"?"error":"pill"}>{item.status}</span></div>})}</div>
  </div>
</div>}

    <div className="rh-premium-card"><div className="rh-card-glow"/><div className="rh-premium-card-inner"><div className="rh-section-label"><Mail size={13}/> Account</div><h2 className="rh-admin-title">Your account</h2><p className="rh-muted">Email: {user?.email}</p></div></div>
  </section>;
}

function Metric({title,value,icon}){return <div className="metric"><div className="feature-icon">{icon}</div><span>{title}</span><strong>{value}</strong></div>}

/* =========================================================
   ADMIN
========================================================= */

function Admin({ user, profile }) {
  const [plans,setPlans]=useState([]);
  const [payments,setPayments]=useState([]);
  const [paymentMethods,setPaymentMethods]=useState([]);
  const [customers,setCustomers]=useState([]);
  const [withdrawals,setWithdrawals]=useState([]);
  const [loading,setLoading]=useState(true);
  const [message,setMessage]=useState("");
  const [error,setError]=useState("");
  const [customerSearch,setCustomerSearch]=useState("");
  const [savingPlan,setSavingPlan]=useState(null);
  const [savingMethod,setSavingMethod]=useState(null);
  const [processingPayment,setProcessingPayment]=useState(null);
  const [processingWithdrawal,setProcessingWithdrawal]=useState(null);
  const [acDepositInputs,setAcDepositInputs]=useState({});
  const [gameACInputs,setGameACInputs]=useState({});
  const [slipUrls,setSlipUrls]=useState({});
  const [newMethod,setNewMethod]=useState({name:"",account_name:"",account_number:"",instructions:""});
  const [commissionRate,setCommissionRate]=useState(getAdminCommissionRate());
  const [savingCommission,setSavingCommission]=useState(false);
  const [referralRate,setReferralRate]=useState(getReferralSettings().rate);
  const [referralTiming,setReferralTiming]=useState(getReferralSettings().timing);
  const [savingReferralSettings,setSavingReferralSettings]=useState(false);
  const [customerBalances,setCustomerBalances]=useState({});
  const [newPlan,setNewPlan]=useState({name:"",description:"",price:"",daily_earning_rate:"10",duration_days:"",referral_commission:"",status:"active"});
  const [creatingPlan,setCreatingPlan]=useState(false);
  const [resettingCustomer,setResettingCustomer]=useState(null);
  const [updatingWithdrawalLock,setUpdatingWithdrawalLock]=useState(null);
  const [referralWithdrawalPercentage,setReferralWithdrawalPercentage]=useState(getReferralWithdrawalPercentage());
  const [savingReferralWithdrawalPercentage,setSavingReferralWithdrawalPercentage]=useState(false);
  const [deletingCustomer,setDeletingCustomer]=useState(null);

  async function loadCustomerBalances(customerRows){
    const rows=customerRows||[];
    const allowed=new Set(rows.map(c=>c.id));
    const next=Object.fromEntries(rows.map(c=>[c.id,0]));
    if(!allowed.size){setCustomerBalances(next);return;}
    try{
      const r=await supabase
        .from("customer_wallet_summary")
        .select("customer_id,balance")
        .in("customer_id",Array.from(allowed));
      if(!r.error){
        (r.data||[]).forEach(row=>{
          if(allowed.has(row.customer_id)){
            const value=Number(row.balance||0);
            if(Number.isFinite(value))next[row.customer_id]=Number(Math.max(0,value).toFixed(2));
          }
        });
      }
    }catch{}
    setCustomerBalances(next);
  }

  async function loadAdminData(){
    setLoading(true);setError("");
    const [plansResult,paymentsResult,methodsResult,customersResult,withdrawalsResult]=await Promise.all([
      supabase.from("plans").select("*").order("name"),
      supabase.from("payments").select("*").order("created_at",{ascending:false}),
      supabase.from("payment_methods").select("*").order("created_at",{ascending:true}),
      supabase.from("profiles").select("*").order("created_at",{ascending:false}),
      supabase.from("ac_withdrawal_requests").select("*").order("created_at",{ascending:false})
    ]);
    if(plansResult.error)setError(plansResult.error.message);else setPlans(sortPlans(plansResult.data));
    if(paymentsResult.error)setError((c)=>c||paymentsResult.error.message);else setPayments(paymentsResult.data||[]);
    if(methodsResult.error)setError((c)=>c||methodsResult.error.message);else setPaymentMethods(methodsResult.data||[]);
    if(customersResult.error)setError((c)=>c||`Customers: ${customersResult.error.message}`);else {const rows=(customersResult.data||[]).filter((x)=>x.role!=="admin");setCustomers(rows);await loadCustomerBalances(rows);}
    if(withdrawalsResult.error)setError((c)=>c||`AC withdrawals: ${withdrawalsResult.error.message}`);else setWithdrawals(withdrawalsResult.data||[]);
    setCommissionRate(getAdminCommissionRate());
    try{setReferralWithdrawalPercentage(await getReferralWithdrawalPercentageRemote());}catch{}
    setLoading(false);
    if(paymentsResult.data)await loadSlipUrls(paymentsResult.data);
  }

  async function loadSlipUrls(paymentRows){
    const entries=await Promise.all((paymentRows||[]).filter((p)=>p.payment_slip_path).map(async(p)=>{const {data,error}=await supabase.storage.from(PAYMENT_SLIP_BUCKET).createSignedUrl(p.payment_slip_path,3600);return [p.id,error?"":data?.signedUrl||""];}));
    setSlipUrls(Object.fromEntries(entries.filter(([,url])=>url)));
  }

  useEffect(()=>{loadAdminData();},[]);

  async function saveCommissionRate(){
    const rate=Number(commissionRate);
    if(!Number.isFinite(rate)||rate<MIN_ADMIN_COMMISSION_RATE||rate>MAX_ADMIN_COMMISSION_RATE){setError(`Commission rate must be between ${MIN_ADMIN_COMMISSION_RATE}% and ${MAX_ADMIN_COMMISSION_RATE}%.`);return;}
    setSavingCommission(true);setError("");setMessage("");
    const saved=saveAdminCommissionRate(rate);
    setCommissionRate(saved);
    setMessage(`Website management fee set to ${saved}%. New withdrawal requests will use this rate.`);
    setSavingCommission(false);
  }

  function saveReferralCommissionSettings(){
    const rate=Number(referralRate);
    if(!Number.isFinite(rate)||rate<MIN_REFERRAL_COMMISSION_RATE||rate>MAX_REFERRAL_COMMISSION_RATE){setError(`Referral commission rate must be between ${MIN_REFERRAL_COMMISSION_RATE}% and ${MAX_REFERRAL_COMMISSION_RATE}%.`);return;}
    setSavingReferralSettings(true);setError("");setMessage("");
    const saved=saveReferralSettings(rate,referralTiming);
    setReferralRate(saved.rate);setReferralTiming(saved.timing);
    setMessage(`Referral commission set to ${saved.rate}% with ${saved.timing==="one_time"?"one-time":"every-24-hours"} timing.`);
    setSavingReferralSettings(false);
  }

  async function saveReferralWithdrawalPercentageSetting(){
    const value=Number(referralWithdrawalPercentage);
    if(!Number.isFinite(value)||value<1||value>100){
      setError("Referral withdrawal percentage must be between 1% and 100%.");
      return;
    }
    setSavingReferralWithdrawalPercentage(true);
    setError("");
    setMessage("");
    try{
      const saved=await saveReferralWithdrawalPercentageRemote(value);
      setReferralWithdrawalPercentage(saved);
      setMessage(`Referral withdrawal percentage set to ${saved}%. It is now stored in Supabase and applies to every customer's qualifying withdrawal unlock.`);
    }catch(err){
      setError(`Could not save referral withdrawal percentage: ${err?.message||"Unknown error"}`);
    }finally{
      setSavingReferralWithdrawalPercentage(false);
    }
  }

  async function deleteCustomerCompletely(customer){
    if(!customer?.id)return;

    const customerName=customer.full_name||customer.email||customer.id;
    const confirmed=window.confirm(
      `DELETE ${customerName} COMPLETELY?\n\n`+
      `This is different from Reset Customer.\n\n`+
      `DELETE means remove this customer's application data, purchased plans, deposits/payment records, payment slips, withdrawals, wallet/balance records, earnings, referral records and public profile. `+
      `If your Supabase project has the admin_delete_customer_completely RPC, it will also remove the Supabase Auth user ID.\n\n`+
      `The action cannot be undone.`
    );
    if(!confirmed)return;

    setDeletingCustomer(customer.id);
    setMessage("");
    setError("");

    try{
      const failures=[];

      /*
       * BEST PATH:
       * A SECURITY DEFINER Supabase RPC can delete auth.users as well as
       * public application rows. Browser-side Supabase clients cannot call
       * supabase.auth.admin.deleteUser(), so the RPC is the only safe way
       * for this App.jsx to remove the actual Auth user ID.
       *
       * If the RPC does not exist, continue with the application-data
       * deletion fallback below rather than pretending Auth was deleted.
       */
      let rpcDeleted=false;
      try{
        const rpc=await supabase.rpc("admin_delete_customer_completely",{p_user_id:customer.id});
        if(!rpc.error){
          rpcDeleted=true;
        }else if(!/function .*admin_delete_customer_completely.*does not exist|could not find the function|schema cache/i.test(String(rpc.error.message||""))){
          failures.push(`Complete customer deletion RPC: ${rpc.error.message}`);
        }
      }catch{}

      if(!rpcDeleted){
        /*
         * Delete child records before customer/profile records.  This path
         * is intentionally defensive because this project has had multiple
         * schema versions.
         */

        // Payment-slip files must be read before payment rows are deleted.
        try{
          const {data:paymentRows,error:paymentRowsError}=await supabase
            .from("payments")
            .select("payment_slip_path")
            .eq("user_id",customer.id);

          if(paymentRowsError){
            if(!/column .*does not exist|relation .* does not exist/i.test(String(paymentRowsError.message||""))){
              failures.push(`Payment slips: ${paymentRowsError.message}`);
            }
          }else{
            const paths=(paymentRows||[]).map(r=>r.payment_slip_path).filter(Boolean);
            if(paths.length){
              const storageDelete=await supabase.storage.from(PAYMENT_SLIP_BUCKET).remove(paths);
              if(storageDelete.error)failures.push(`Payment-slip files: ${storageDelete.error.message}`);
            }
          }
        }catch(err){
          failures.push(`Payment-slip files: ${err?.message||"Unknown error"}`);
        }

        // customer_plans can reference payment_requests through an FK.
        // Delete the child rows before payment/request rows to avoid FK errors.
        for(const condition of [
          {column:"customer_id",value:customer.id},
          {column:"user_id",value:customer.id}
        ]){
          try{
            const r=await supabase.from("customer_plans").delete().eq(condition.column,condition.value);
            if(r.error && !/column .*does not exist|relation .* does not exist/i.test(String(r.error.message||""))){
              // A duplicate delete using the alternate column is expected to fail
              // only when that schema variant is absent.
              if(condition.column==="customer_id") failures.push(`Purchased plans: ${r.error.message}`);
            }
          }catch{}
        }

        // Deposits/payment requests. Try common ownership columns.
        for(const table of ["payments","payment_requests"]){
          for(const column of ["user_id","customer_id"]){
            try{
              const r=await supabase.from(table).delete().eq(column,customer.id);
              if(r.error && !/column .*does not exist|relation .* does not exist/i.test(String(r.error.message||""))){
                if(column==="user_id") failures.push(`${table}: ${r.error.message}`);
              }
            }catch{}
          }
        }

        // Withdrawals.
        for(const column of ["customer_id","user_id"]){
          try{
            const r=await supabase.from("withdrawal_requests").delete().eq(column,customer.id);
            if(r.error && !/column .*does not exist|relation .* does not exist/i.test(String(r.error.message||""))){
              if(column==="customer_id") failures.push(`Withdrawals: ${r.error.message}`);
            }
          }catch{}
        }

        // Wallet/balance tables. Delete rows rather than only setting zero:
        // a deleted customer must not reappear with an old balance later.
        for(const table of ["customer_wallet_transactions","wallet_balances","customer_balances","player_balances"]){
          for(const column of ["user_id","customer_id"]){
            try{
              const r=await supabase.from(table).delete().eq(column,customer.id);
              if(r.error && !/column .*does not exist|relation .* does not exist/i.test(String(r.error.message||""))){
                if(column==="user_id") failures.push(`${table}: ${r.error.message}`);
              }
            }catch{}
          }
        }

        // Earnings/commission/referral records. Try the ownership columns
        // supported by different versions of the project.
        const referralTables=[
          ["earnings",["user_id","customer_id"]],
          ["referral_commissions",["user_id","customer_id","referrer_id","referred_user_id","referred_customer_id"]],
          ["referrals",["user_id","customer_id","referrer_id","referred_user_id","referred_customer_id"]]
        ];
        for(const [table,columns] of referralTables){
          for(const column of columns){
            try{
              const r=await supabase.from(table).delete().eq(column,customer.id);
              if(r.error && !/column .*does not exist|relation .* does not exist/i.test(String(r.error.message||""))){
                // Only surface a real table-level error once.
                if(column===columns[0])failures.push(`${table}: ${r.error.message}`);
              }
            }catch{}
          }
        }

        // Remove referral references from other profiles before deleting this
        // customer's profile, otherwise a profile FK can block deletion.
        for(const column of ["referrer_id","referred_by"]){
          try{
            const r=await supabase.from("profiles").update({[column]:null}).eq(column,customer.id);
            if(r.error && !/column .*does not exist|relation .* does not exist/i.test(String(r.error.message||""))){
              failures.push(`Referral references (${column}): ${r.error.message}`);
            }
          }catch{}
        }

        // Finally remove the public profile/customer row.
        const profileDelete=await supabase.from("profiles").delete().eq("id",customer.id);
        if(profileDelete.error){
          failures.push(`Customer profile: ${profileDelete.error.message}`);
        }

        // IMPORTANT: The fallback cannot delete auth.users from a browser
        // using the publishable/anon key. Never claim that it did.
        failures.push("Supabase Auth ID was not deleted because admin_delete_customer_completely RPC is not installed.");
      }

      // Remove local cached data so a deleted customer cannot return from
      // browser storage after the database refresh.
      try{localStorage.removeItem(earningsStorageKey(customer.id));}catch{}
      try{localStorage.removeItem(customerProfileSeenKey(customer.id));}catch{}
      try{localStorage.removeItem(`rh_customer_reset_at_${customer.id}`);}catch{}

      setCustomerBalances(current=>{
        const next={...current};
        delete next[customer.id];
        return next;
      });

      if(rpcDeleted && failures.length===0){
        setMessage(`${customerName} was completely deleted, including the application customer record. The admin deletion RPC also removed the Supabase Auth user ID.`);
      }else if(failures.length){
        setError(`Customer deletion was not fully completed: ${failures.join(" | ")}`);
      }else{
        setMessage(`${customerName} was deleted from the application database.`);
      }

      await loadAdminData();
    }catch(err){
      setError(`Could not delete ${customerName}: ${err?.message||"Unknown error"}`);
    }finally{
      setDeletingCustomer(null);
    }
  }

  function updatePlanLocal(id,field,value){setPlans(c=>c.map(p=>p.id===id?{...p,[field]:value}:p));}
  async function savePlan(plan){
    setSavingPlan(plan.id);setMessage("");setError("");

    // Keep the three editable plan values as real numbers before sending them
    // to Supabase. In particular, never silently fall back to 10% here: the
    // percentage entered by the administrator must be the value that is saved.
    const price=Number(plan.price);
    const dailyRate=Number(plan.daily_earning_rate);
    const durationDays=Number(plan.duration_days);
    const referralCommission=Number(plan.referral_commission ?? 0);

    if(!Number.isFinite(price)||price<0){setError("Plan amount must be 0 or higher.");setSavingPlan(null);return;}
    if(!Number.isFinite(dailyRate)||dailyRate<0||dailyRate>100){setError("Daily earnings rate must be between 0% and 100%.");setSavingPlan(null);return;}
    if(!Number.isInteger(durationDays)||durationDays<1){setError("Plan duration must be at least 1 day.");setSavingPlan(null);return;}
    if(!Number.isFinite(referralCommission)||referralCommission<0){setError("Referral commission must be 0 or higher.");setSavingPlan(null);return;}

    try{
      const payload={
        description:plan.description||"",
        price,
        daily_earning_rate:dailyRate,
        duration_days:durationDays,
        referral_commission:referralCommission,
        updated_at:new Date().toISOString()
      };

      // Do NOT fall back to an update that omits daily_earning_rate. That old
      // fallback was the reason the UI could appear editable while the 10%
      // value kept coming back after refresh. If the column is missing, show
      // the real database error instead of pretending the change was saved.
      const result=await supabase.from("plans").update(payload).eq("id",plan.id);
      if(result.error){
        if(/daily_earning_rate|column .*does not exist|schema cache/i.test(String(result.error.message||""))){
          throw new Error("The plans table is missing the daily_earning_rate column. Add that column in Supabase, then save the plan again.");
        }
        throw result.error;
      }

      // Read the row back immediately. This verifies that the database really
      // stored the exact percentage instead of only updating React state.
      const verify=await supabase.from("plans").select("*").eq("id",plan.id).maybeSingle();
      if(verify.error)throw verify.error;
      const storedRate=Number(verify.data?.daily_earning_rate);
      if(!verify.data||!Number.isFinite(storedRate)||Math.abs(storedRate-dailyRate)>0.000001){
        throw new Error(`Daily earnings was not saved. You entered ${dailyRate}%, but the database returned ${Number.isFinite(storedRate)?storedRate+"%":"no value"}.`);
      }

      // Replace the local row with the verified database row so every customer
      // screen immediately uses the same saved percentage.
      setPlans(current=>current.map(p=>p.id===plan.id?{...p,...verify.data,daily_earning_rate:storedRate}:p));
      setMessage(`${planLabel({...plan,...verify.data})} saved successfully. Daily earnings: ${storedRate}%.`);
    }catch(err){
      setError(err?.message||"Could not save plan.");
    }finally{
      setSavingPlan(null);
    }
  }

  async function createPlan(){
    const name=newPlan.name.trim();
    const description=newPlan.description.trim();
    const price=Number(newPlan.price);
    const dailyEarningRate=Number(newPlan.daily_earning_rate);
    const durationDays=Number(newPlan.duration_days);
    const referralCommission=Number(newPlan.referral_commission);
    if(!name){setError("Enter a plan name.");return;}
    if(!Number.isFinite(price)||price<0){setError("Enter a valid plan price.");return;}
    if(!Number.isFinite(dailyEarningRate)||dailyEarningRate<0){setError("Daily earnings rate must be 0 or higher.");return;}
    if(!Number.isInteger(durationDays)||durationDays<1){setError("Duration must be at least 1 day.");return;}
    if(!Number.isFinite(referralCommission)||referralCommission<0){setError("Enter a valid referral commission.");return;}
    setCreatingPlan(true);setMessage("");setError("");
    try{
      const result=await supabase.from("plans").insert({
        name,
        description,
        price,
        daily_earning_rate:dailyEarningRate,
        duration_days:durationDays,
        referral_commission:referralCommission,
        status:newPlan.status==="inactive"?"inactive":"active"
      }).select().single();
      const data=result.data; const error=result.error;
      if(error){
        if(/daily_earning_rate|column .*does not exist|schema cache/i.test(String(error.message||""))){
          throw new Error("TA777Gaming plans table needs the daily_earning_rate column before a plan can be created.");
        }
        throw error;
      }
      setPlans(current=>[...current,data]);
      setNewPlan({name:"",description:"",price:"",daily_earning_rate:"10",duration_days:"",referral_commission:"",status:"active"});
      setMessage(`${name} created successfully.`);
    }catch(err){setError(`Could not create plan: ${err?.message||"Unknown error"}`);}
    finally{setCreatingPlan(false);}
  }

  async function createPlansOneToTen(){
    setCreatingPlan(true);setMessage("");setError("");
    try{
      const existingNumbers=new Set(plans.map((p,i)=>planNumber(p,i)));
      const missing=[];
      for(let i=1;i<=10;i++){
        if(!existingNumbers.has(i)){
          missing.push({name:`Plan ${i}`,description:`Customer investment Plan ${i}`,price:1000,daily_earning_rate:10,duration_days:30,referral_commission:0,status:"active"});
        }
      }
      if(!missing.length){setMessage("Plans 1 to 10 already exist.");return;}
      const result=await supabase.from("plans").insert(missing).select();
      if(result.error){
        if(/daily_earning_rate|column .*does not exist|schema cache/i.test(String(result.error.message||""))){
          throw new Error("TA777Gaming plans table needs the daily_earning_rate column before Plans 1-10 can be created.");
        }
        throw result.error;
      }
      setPlans(current=>sortPlans([...current,...(result.data||[])]));
      setMessage(`Created ${result.data?.length||0} missing plans. You can edit each plan's amount, daily earnings and duration below.`);
    }catch(err){setError(`Could not create Plans 1-10: ${err?.message||"Unknown error"}`);}
    finally{setCreatingPlan(false);}
  }

  function generateFreshCustomerReferralCode(){
    const stamp=Date.now().toString(36).toUpperCase();
    const random=Math.random().toString(36).slice(2,7).toUpperCase();
    return `RH${stamp}${random}`.slice(0,16);
  }

  async function resetCustomerData(customer){
    if(!customer?.id)return;

    const customerName=customer.full_name||customer.email||customer.id;
    const confirmed=window.confirm(
      `Reset ${customerName} completely?\\n\\nThis makes the account start again like a new customer: all purchased/active plans, deposits/payment records, payment-slip history, withdrawals, wallet balance, earnings and referral progress are cleared. A fresh referral code is generated and the join date is reset.\\n\\nThe Supabase Auth login ID cannot be changed from the browser; the same login remains available so the customer can sign in again.\\n\\nThis action cannot be undone.`
    );
    if(!confirmed)return;

    setResettingCustomer(customer.id);
    setMessage("");
    setError("");

    try{
      const failures=[];

      // Preferred atomic path. This is the only reliable way to clear every
      // related row without FK/order problems when the project has the helper RPC.
      let rpcReset=false;
      try{
        const rpc=await supabase.rpc("admin_reset_customer_completely",{p_user_id:customer.id});
        if(!rpc.error){
          rpcReset=true;
          try{localStorage.removeItem(earningsStorageKey(customer.id));}catch{}
          try{localStorage.removeItem(customerProfileSeenKey(customer.id));}catch{}
          try{localStorage.setItem(`rh_customer_reset_at_${customer.id}`,new Date().toISOString());}catch{}
          setCustomerBalances(current=>({...current,[customer.id]:0}));
          setMessage(`${customerName} was completely reset. Wallet balance is Rs 0 and all plans, deposits, withdrawals, proofs and referral progress were removed.`);
          await loadAdminData();
          return;
        }
        if(!/function .*admin_reset_customer_completely.*does not exist|could not find the function|schema cache/i.test(String(rpc.error.message||""))){
          failures.push(`Complete reset RPC: ${rpc.error.message}`);
        }
      }catch{}

      const customerPlansDelete=await supabase
        .from("customer_plans")
        .delete()
        .eq("customer_id",customer.id);
      if(customerPlansDelete.error)failures.push(`Purchased plans: ${customerPlansDelete.error.message}`);

      // Remove uploaded payment-slip files belonging to this customer too.
      // Read the paths before deleting the payment rows.
      try{
        const {data:customerPaymentRows,error:paymentRowsError}=await supabase
          .from("payments")
          .select("payment_slip_path")
          .eq("user_id",customer.id);
        if(paymentRowsError){
          failures.push(`Payment slips: ${paymentRowsError.message}`);
        }else{
          const slipPaths=(customerPaymentRows||[])
            .map(row=>row.payment_slip_path)
            .filter(Boolean);
          if(slipPaths.length){
            const {error:slipDeleteError}=await supabase.storage
              .from(PAYMENT_SLIP_BUCKET)
              .remove(slipPaths);
            if(slipDeleteError)failures.push(`Payment-slip files: ${slipDeleteError.message}`);
          }
        }
      }catch(err){
        failures.push(`Payment-slip files: ${err?.message||"Could not remove uploaded slips"}`);
      }

      const paymentsDelete=await supabase
        .from("payments")
        .delete()
        .eq("user_id",customer.id);
      if(paymentsDelete.error)failures.push(`Deposits: ${paymentsDelete.error.message}`);

      // Old versions also keep deposit requests in payment_requests. Delete
      // these after customer_plans so the FK cannot resurrect old plan data.
      for(const column of ["user_id","customer_id"]){
        try{
          const r=await supabase.from("payment_requests").delete().eq(column,customer.id);
          if(r.error && !/column .*does not exist|relation .* does not exist/i.test(String(r.error.message||""))){
            if(column==="user_id")failures.push(`Payment requests: ${r.error.message}`);
          }
        }catch{}
      }

      const withdrawalsByCustomer=await supabase
        .from("withdrawal_requests")
        .delete()
        .eq("customer_id",customer.id);
      if(withdrawalsByCustomer.error && !/column .*customer_id.*does not exist/i.test(withdrawalsByCustomer.error.message||"")){
        failures.push(`Withdrawals: ${withdrawalsByCustomer.error.message}`);
      }

      const withdrawalsByUser=await supabase
        .from("withdrawal_requests")
        .delete()
        .eq("user_id",customer.id);
      if(withdrawalsByUser.error && !/column .*user_id.*does not exist/i.test(withdrawalsByUser.error.message||"")){
        failures.push(`Legacy withdrawals: ${withdrawalsByUser.error.message}`);
      }

      // IMPORTANT: the original TA777Gaming wallet is player_balances. The old
      // reset code skipped it, so a customer could be reset to Rs 0 in the UI and
      // then return to the old balance after the next refresh. Zero every known
      // wallet source before refreshing the admin list.
      await resetPersistentWalletCompletely(customer.id,failures);

      const resetTimestamp=new Date().toISOString();
      const freshReferralCode=generateFreshCustomerReferralCode();

      const profileUpdate=await supabase
        .from("profiles")
        .update({updated_at:resetTimestamp,created_at:resetTimestamp,referral_code:freshReferralCode})
        .eq("id",customer.id);
      if(profileUpdate.error){
        const fallback=await supabase
          .from("profiles")
          .update({updated_at:resetTimestamp,referral_code:freshReferralCode})
          .eq("id",customer.id);
        if(fallback.error)failures.push(`Customer profile reset: ${fallback.error.message}`);
      }

      try{localStorage.removeItem(earningsStorageKey(customer.id));}catch{}
      try{localStorage.setItem(customerProfileSeenKey(customer.id),resetTimestamp);}catch{}
      try{localStorage.setItem(`rh_customer_reset_at_${customer.id}`,resetTimestamp);}catch{}

      setCustomerBalances(current=>({...current,[customer.id]:0}));

      if(failures.length){
        setError(`Customer reset completed with some database warnings: ${failures.join(" | ")}`);
      }else{
        setMessage(`${customerName} has been completely reset as a fresh customer. Old plans, deposits, withdrawals, wallet, earnings and referral history were cleared. Wallet balance is now Rs 0. New referral code: ${freshReferralCode}.`);
      }

      await loadAdminData();
    }catch(err){
      setError(`Could not reset ${customerName}: ${err?.message||"Unknown error"}`);
    }finally{
      setResettingCustomer(null);
    }
  }

  async function setCustomerWithdrawalLock(customer,locked){
    setUpdatingWithdrawalLock(customer.id);setMessage("");setError("");
    try{const r=await supabase.from("profiles").update({withdrawal_locked:locked,updated_at:new Date().toISOString()}).eq("id",customer.id);if(r.error){if(/withdrawal_locked|column/i.test(r.error.message||""))throw new Error("Add a boolean withdrawal_locked column to profiles in Supabase, then try again.");throw r.error;}setCustomers(current=>current.map(c=>c.id===customer.id?{...c,withdrawal_locked:locked}:c));setMessage(`${customer.full_name||customer.email||"Customer"} withdrawals are now ${locked?"locked":"unlocked"}.`);}catch(err){setError(err?.message||"Could not update withdrawal lock.");}finally{setUpdatingWithdrawalLock(null);}
  }

  function updateMethodLocal(id,field,value){setPaymentMethods(c=>c.map(m=>m.id===id?{...m,[field]:value}:m));}
  async function saveMethod(method){setSavingMethod(method.id);setMessage("");setError("");const {error:e}=await supabase.from("payment_methods").update({name:method.name,account_name:method.account_name,account_number:method.account_number,instructions:method.instructions,is_active:method.is_active,updated_at:new Date().toISOString()}).eq("id",method.id);if(e)setError(e.message);else setMessage(`${method.name} updated.`);setSavingMethod(null);}

  async function addPaymentMethod(){
    if(!newMethod.name.trim()){setError("Enter a payment method name.");return;}
    setMessage("");setError("");
    const {error:e}=await supabase.from("payment_methods").insert({name:newMethod.name.trim(),account_name:newMethod.account_name.trim(),account_number:newMethod.account_number.trim(),instructions:newMethod.instructions.trim(),is_active:true});
    if(e){const detail=e.message||"Unknown database error";setError(/row.level security|permission denied|not allowed/i.test(detail)?`Could not add payment method because Supabase blocked the insert. Run TA777Gaming_PAYMENT_METHODS_FIX.sql in the Supabase SQL Editor, then refresh this page. Details: ${detail}`:`Could not add payment method: ${detail}`);return;}
    setNewMethod({name:"",account_name:"",account_number:"",instructions:""});
    setMessage("New payment method added. You can add another one immediately.");
    await loadAdminData();
  }

  async function deletePaymentMethod(method){
    if(!window.confirm(`Delete ${method.name}?`))return;
    const {error:e}=await supabase.from("payment_methods").delete().eq("id",method.id);
    if(e){setError(e.message);return;}
    setMessage(`${method.name} deleted.`);await loadAdminData();
  }

  async function addGameACTokensForDeposit(paymentId,customerId,amount){
    const n=Number(amount);
    if(!Number.isFinite(n)||n<0)throw new Error("Enter a valid game AC token amount.");
    if(n===0)return 0;
    // Use the AC-wallet adjustment RPC that exists in this Supabase project.
    const {data,error}=await supabase.rpc("ac_admin_adjust_wallet",{p_user_id:customerId,p_amount:n,p_note:`Deposit approval ${paymentId}`});
    if(error)throw error;
    return Number(data||0);
  }

  async function approveWalletDeposit(payment, acAmount=0){
    const amount=Number(acAmount);
    if(!Number.isFinite(amount)||amount<50)throw new Error("Enter the AC amount to add. Minimum is 50 AC.");
    // A single server transaction approves the deposit and credits the same AC
    // wallet used by the games. It prevents an approved-but-uncredited request.
    const {data,error}=await supabase.rpc("ta777_admin_approve_ac_deposit",{
      p_payment_id:payment.id,
      p_ac_amount:amount
    });
    if(error)throw error;
    if(data===null||typeof data==="undefined")throw new Error("The server did not confirm the AC credit.");
    setMessage(`Deposit approved. ${amount.toLocaleString()} AC added to the customer's shared AC balance.`);
  }

  async function approvePayment(payment){
    const acAmount=Number(acDepositInputs[payment.id]||0);
    if(!Number.isFinite(acAmount)||acAmount<50){setError("Enter the AC amount to add. Minimum is 50 AC.");return;}
    const isWalletDeposit=payment.payment_type==="wallet_deposit"||String(payment.transaction_reference||"").startsWith("WALLET_DEPOSIT:");
    if(isWalletDeposit){setProcessingPayment(payment.id);setMessage("");setError("");try{await approveWalletDeposit(payment,acAmount);await loadAdminData();}catch(err){setError(err?.message||"Could not approve wallet deposit.");}finally{setProcessingPayment(null);}return;}
    setProcessingPayment(payment.id);setMessage("");setError("");
    try{
      if(payment.status!=="pending")throw new Error("This payment has already been reviewed.");

      let planResult=await supabase.from("plans").select("id,name,duration_days,daily_earning_rate").eq("id",payment.plan_id).maybeSingle();
      if(planResult.error && /daily_earning_rate|column/i.test(planResult.error.message||"")){
        planResult=await supabase.from("plans").select("id,name,duration_days").eq("id",payment.plan_id).maybeSingle();
      }
      const {data:plan,error:pe}=planResult;
      if(pe)throw pe;
      if(!plan)throw new Error("Plan not found.");

      const {data:existing,error:ee}=await supabase.from("customer_plans").select("id,starts_at,ends_at,status").eq("payment_request_id",payment.id).maybeSingle();
      if(ee)throw ee;

      const reviewedAt=new Date().toISOString();

      const {data:updatedPayment,error:ue}=await supabase.from("payments").update({
        status:"approved",
        reviewed_by:user.id,
        reviewed_at:reviewedAt
      }).eq("id",payment.id).eq("status","pending").select().maybeSingle();

      if(ue)throw ue;
      if(!updatedPayment)throw new Error("This payment was already processed.");

      let newCustomerPlanId=null;

      if(existing){
        const {error:re}=await supabase.from("customer_plans").update({
          status:"active",
          starts_at:existing.starts_at||reviewedAt,
          ends_at:existing.ends_at||new Date(new Date(reviewedAt).getTime()+Number(plan.duration_days||45)*EARNING_INTERVAL_MS).toISOString()
        }).eq("id",existing.id);

        if(re){
          await supabase.from("payments").update({status:"pending",reviewed_by:null,reviewed_at:null}).eq("id",payment.id).eq("status","approved");
          throw re;
        }
      }else{
        const start=new Date(reviewedAt);
        const end=new Date(start);
        end.setDate(end.getDate()+Number(plan.duration_days||45));

        /*
         * IMPORTANT:
         * In some TA777Gaming database versions customer_plans.payment_request_id
         * points to the old payment_requests table, while the current app uses
         * the payments table. Putting payments.id into that FK causes:
         *   "customer_plans_payment_request_id_fkey"
         *
         * First try to find a real payment_request id. If none exists, leave the
         * optional FK empty instead of inserting an id from the wrong table.
         */
        let validPaymentRequestId=null;
        try{
          const candidates=[
            ["id",payment.id],
            ["payment_id",payment.id]
          ];
          for(const [field,value] of candidates){
            try{
              const pr=await supabase.from("payment_requests").select("id").eq(field,value).maybeSingle();
              if(!pr.error&&pr.data?.id){validPaymentRequestId=pr.data.id;break;}
            }catch{}
          }
          if(!validPaymentRequestId){
            const variants=[
              {user_id:payment.user_id,plan_id:payment.plan_id},
              {customer_id:payment.user_id,plan_id:payment.plan_id},
              {user_id:payment.user_id}
            ];
            for(const filters of variants){
              try{
                let q=supabase.from("payment_requests").select("id").order("created_at",{ascending:false}).limit(1);
                for(const [k,v] of Object.entries(filters))q=q.eq(k,v);
                const pr=await q.maybeSingle();
                if(!pr.error&&pr.data?.id){validPaymentRequestId=pr.data.id;break;}
              }catch{}
            }
          }
        }catch{}

        newCustomerPlanId=crypto.randomUUID();
        const basePlan={
          id:newCustomerPlanId,
          customer_id:payment.user_id,
          plan_id:payment.plan_id,
          price_paid:Number(payment.amount),
          starts_at:start.toISOString(),
          ends_at:end.toISOString(),
          status:"active"
        };
        if(validPaymentRequestId)basePlan.payment_request_id=validPaymentRequestId;

        let cp=await supabase.from("customer_plans").insert(basePlan);

        /*
         * If this database makes payment_request_id nullable, the insert above
         * succeeds with no FK value. If it is NOT NULL, retrying cannot invent
         * a valid FK. In that case surface the real schema requirement rather
         * than silently approving a payment without an active plan.
         */
        if(cp.error){
          await supabase.from("payments").update({status:"pending",reviewed_by:null,reviewed_at:null}).eq("id",payment.id).eq("status","approved");
          throw cp.error;
        }
      }

      const planRate=Number(plan.daily_earning_rate??10);
      const immediate=Number((Number(payment.amount||0)*(planRate/100)).toFixed(2));
      // Best effort only. If the admin RLS policy permits it, the first earning
      // is written immediately during approval. If admin wallet writes are
      // restricted, the customer dashboard performs the same idempotent write.
      if(immediate>0){
        const approvedPlanId = existing?.id || newCustomerPlanId;
        await incrementPersistentWalletBalance(payment.user_id,immediate,{sourceKey:`INITIAL_EARNING:${approvedPlanId}`,sourceId:approvedPlanId,transactionType:"earning",description:`First ${planRate}% earning from ${plan.name||"plan"}`});
      }
      const gameACAdded=await addGameACTokensForDeposit(payment.id,payment.user_id,acAmount);
      setMessage(`Payment approved. ${plan.name} is active for ${plan.duration_days} days. ${gameACAdded.toLocaleString()} AC added to the customer's shared AC balance. The first ${planRate}% (Rs ${immediate.toLocaleString()}) is credited immediately.`);
      await loadAdminData();
    }catch(err){
      setError(err?.message||"Could not approve payment.");
    }finally{
      setProcessingPayment(null);
    }
  }

  async function rejectPayment(payment){setProcessingPayment(payment.id);setMessage("");setError("");const {error:e}=await supabase.from("payments").update({status:"rejected",reviewed_by:user.id,reviewed_at:new Date().toISOString()}).eq("id",payment.id).eq("status","pending");if(e)setError(e.message);else{setMessage("Payment rejected.");await loadAdminData();}setProcessingPayment(null);}

  async function approveWithdrawal(w){
    setProcessingWithdrawal(w.id);setMessage("");setError("");
    try{const {data,error}=await supabase.rpc("ta777_admin_process_ac_withdrawal",{p_request_id:w.id,p_action:"approve"});if(error)throw error;setMessage(`Withdrawal approved. ${Number(w.amount||0).toLocaleString()} AC deducted from the customer's shared AC balance.`);await loadAdminData();}
    catch(err){setError(err?.message||"Could not approve AC withdrawal.");}finally{setProcessingWithdrawal(null);}
  }
  async function rejectWithdrawal(w){setProcessingWithdrawal(w.id);setMessage("");setError("");try{const {error}=await supabase.rpc("ta777_admin_process_ac_withdrawal",{p_request_id:w.id,p_action:"reject"});if(error)throw error;setMessage("Withdrawal rejected. Customer AC balance was not changed.");await loadAdminData();}catch(err){setError(err?.message||"Could not reject AC withdrawal.");}finally{setProcessingWithdrawal(null);}}


  const pendingPayments=payments.filter(p=>p.status==="pending");
  const pendingWithdrawals=withdrawals.filter(w=>w.status==="pending");
  const approvedWithdrawals=withdrawals.filter(w=>w.status==="approved");
  const rejectedWithdrawals=withdrawals.filter(w=>w.status==="rejected");
  const totalCommission=approvedWithdrawals.reduce((s,w)=>s+Number(w.admin_commission||Number(w.amount||0)*(Number(w.commission_rate||commissionRate)/100)),0);
  const todayKey=new Date().toISOString().slice(0,10);
  const todayCommission=approvedWithdrawals.filter(w=>w.reviewed_at&&new Date(w.reviewed_at).toISOString().slice(0,10)===todayKey).reduce((s,w)=>s+Number(w.admin_commission||Number(w.amount||0)*(Number(w.commission_rate||commissionRate)/100)),0);
  const activeMethods=paymentMethods.filter(m=>m.is_active);
  const filteredCustomers=customers.filter(c=>`${c.full_name||""} ${c.email||""} ${c.referral_code||""}`.toLowerCase().includes(customerSearch.toLowerCase()));

  return <section className="page-section">
    <PremiumProfile user={user} profile={profile} admin stats={[
      {label:"Customers",value:customers.length},
      {label:"Pending deposits",value:pendingPayments.length},
      {label:"Total commission",value:`Rs ${totalCommission.toLocaleString()}`}
    ]} />

    <div className="dashboard-head">
      <div>
        <span className="eyebrow">TA777GAMING ADMIN</span>
        <h1>Control center</h1>
        <p className="muted">Every important platform operation is separated into its own section.</p>
      </div>
      <span className="status">ADMIN</span>
    </div>

    {message&&<div className="rh-success">{message}</div>}
    {error&&<div className="rh-error">{error}</div>}

    <div className="dashboard-grid">
      <Metric title="Registered customers" value={customers.length} icon={<Users/>}/>
      <Metric title="Pending deposits" value={pendingPayments.length} icon={<CreditCard/>}/>
      <Metric title="Payment methods" value={activeMethods.length} icon={<Wallet/>}/>
      <Metric title="Withdrawal requests" value={pendingWithdrawals.length} icon={<DollarSign/>}/>
      <Metric title="Today's commission" value={`Rs ${todayCommission.toLocaleString()}`} icon={<Crown/>}/>
      <Metric title="Total commission" value={`Rs ${totalCommission.toLocaleString()}`} icon={<Crown/>}/>
    </div>

    <div className="admin-section-bar" aria-label="Admin sections">
      <a className="admin-section-tile" href="#admin-customers"><Users size={18}/><span>Customers list</span><small>Players, IDs, names/numbers, reset & delete</small></a>
      <a className="admin-section-tile" href="#admin-deposit-requests"><CreditCard size={18}/><span>Deposit requests</span><small>All pending customer deposits</small></a>
      <a className="admin-section-tile" href="#admin-withdrawal-requests"><DollarSign size={18}/><span>Withdrawal requests</span><small>Review and approve/reject withdrawals</small></a>
      <a className="admin-section-tile" href="#admin-commission"><BarChart3 size={18}/><span>Website management fee</span><small>Change fee from 5% to 20%</small></a>
      <a className="admin-section-tile" href="#admin-payment-methods"><Wallet size={18}/><span>Payment methods</span><small>Manage customer deposit methods</small></a>
    </div>

    <div className="rh-premium-card">
      <div className="rh-card-glow"/>
      <div className="rh-premium-card-inner">
        <div className="rh-section-label"><ShieldCheck size={13}/> Administrator controls</div>
        <h2 className="rh-admin-title">Everything is organized separately</h2>
        <p className="rh-muted">Open each separate management section above to manage customers, deposits, withdrawals, the website management fee and payment methods.</p>
      </div>
    </div>

    {/* CUSTOMER LIST */}
    <section id="admin-customers" className="rh-admin-section">
      <div className="rh-admin-section-head">
        <div>
          <div className="rh-section-label"><Users size={13}/> CUSTOMER MANAGEMENT</div>
          <h2>Customers list</h2>
          <p>Customer name, email, referral code, ID, wallet balance and withdrawal controls.</p>
        </div>
        <span className="rh-admin-count">{customers.length} customers</span>
      </div>
      <div className="rh-admin-section-body">
        <div className="rh-search"><Search size={17}/><input value={customerSearch} onChange={(e)=>setCustomerSearch(e.target.value)} placeholder="Search name, email or referral code"/></div>
        {loading&&<p className="rh-muted">Loading customers...</p>}
        {!loading&&filteredCustomers.length===0&&<div className="rh-empty">No customers match your search.</div>}
        {filteredCustomers.map(c=>
          <div className="rh-customer-row" key={c.id}>
            <div className="rh-customer-left">
              <div className="rh-small-avatar"><Initials name={c.full_name} email={c.email}/></div>
              <div className="rh-customer-main">
                <div className="rh-customer-name">{c.full_name||"Unnamed customer"}</div>
                <div className="rh-customer-meta">Phone/Number: {c.phone||c.phone_number||c.mobile||"—"}</div><div className="rh-customer-meta">Email: {c.email||"No email"}</div>
                <div className="rh-customer-meta">Referral: {c.referral_code||"—"} · Joined {c.created_at?new Date(c.created_at).toLocaleDateString():"—"}</div>
                <div className="rh-customer-meta">Customer ID: {c.id}</div>

              </div>
            </div>
            <div className="rh-customer-actions">
              <div className="rh-customer-balance">
                <span className="rh-muted">Current wallet balance</span>
                <div className="rh-balance">Rs {Number(customerBalances[c.id]||0).toLocaleString()}</div>
              </div>
              <span className={c.role==="admin"?"status":"pill"}>{c.role||"customer"}</span>
              <button className="btn danger small" type="button" disabled={resettingCustomer===c.id} onClick={()=>resetCustomerData(c)}>
                <RotateCcw size={14}/>{resettingCustomer===c.id?"Resetting...":"Reset Customer Completely"}
              </button>
              <button className="btn danger small" type="button" disabled={deletingCustomer===c.id} onClick={()=>deleteCustomerCompletely(c)}>
                <XCircle size={14}/>{deletingCustomer===c.id?"Deleting...":"Delete Customer Completely"}
              </button>
            </div>
          </div>
        )}
      </div>
    </section>

    {/* PENDING DEPOSIT REQUESTS */}
    <section id="admin-deposit-requests" className="rh-admin-section">
      <div className="rh-admin-section-head">
        <div>
          <div className="rh-section-label"><CreditCard size={13}/> DEPOSIT REQUESTS</div>
          <h2>Customer deposit requests</h2>
          <p>Review customer details and payment proof, enter the AC tokens to credit, then approve or reject the request.</p>
        </div>
        <span className="rh-admin-count">{pendingPayments.length} pending</span>
      </div>
      <div className="rh-admin-section-body">
        {pendingPayments.length===0?<div className="rh-empty">No pending customer deposits.</div>:pendingPayments.map(p=>{
          const customer=customers.find((c)=>c.id===p.user_id);
          return <div className="admin-plan" key={p.id}>
            <div className="plan-heading">
              <div>
                <span className="eyebrow">PENDING DEPOSIT</span>
                <h2>{p.payment_type==="wallet_deposit"||String(p.transaction_reference||"").startsWith("WALLET_DEPOSIT:")?"Wallet Deposit":planLabel(p.plans)}</h2>
              </div>
              <span className="pill">Pending</span>
            </div>
            <div className="notice">
              <p><strong>Customer:</strong> {customer?.full_name||p.user_id}</p>
              <p><strong>Email:</strong> {customer?.email||"—"}</p>
              <p><strong>Customer ID:</strong> {p.user_id||"—"}</p>
              <p><strong>Customer requested:</strong> Cash In with payment proof (amount is set by admin)</p>
              <p><strong>Minimum AC credit:</strong> 50 AC</p>
              <p><strong>Transaction/reference:</strong> {String(p.transaction_reference||"").replace(/^WALLET_DEPOSIT:/,"")||"—"}</p>
              <p><strong>Submitted:</strong> {p.created_at?new Date(p.created_at).toLocaleString():"—"}</p>
            </div>
            {slipUrls[p.id]?<div className="rh-slip"><img src={slipUrls[p.id]} alt="Customer payment slip"/><a className="rh-slip-link" href={slipUrls[p.id]} target="_blank" rel="noreferrer"><Eye size={14}/> Open full payment slip</a></div>:<div className="rh-warning"><FileImage size={14}/> Payment slip image is not available for this payment.</div>}
            <div className="ta-admin-credit">
              <label><strong>AC to add to customer</strong><span className="muted">Admin sets the amount before approval · minimum 50 AC · credited to the customer's shared AC balance after approval.</span>
                <input type="number" min="50" step="1" inputMode="numeric" value={acDepositInputs[p.id]||""} onChange={e=>setAcDepositInputs(v=>({...v,[p.id]:e.target.value}))} placeholder="Enter AC amount" required/>
              </label>
            </div>
            <div className="hero-actions">
              <button className="btn primary" type="button" disabled={processingPayment===p.id} onClick={()=>approvePayment(p)}><Check size={16}/>{processingPayment===p.id?"Processing...":"Approve Deposit"}</button>
              <button className="btn secondary" type="button" disabled={processingPayment===p.id} onClick={()=>rejectPayment(p)}><XCircle size={16}/>Reject Deposit</button>
            </div>
          </div>
        })}
      </div>
    </section>

    {/* DEPOSIT HISTORY */}
    <section id="admin-deposit-history" className="rh-admin-section">
      <div className="rh-admin-section-head">
        <div>
          <div className="rh-section-label"><CheckCircle2 size={13}/> DEPOSIT HISTORY</div>
          <h2>Approved & rejected deposits</h2>
          <p>Completed customer deposit decisions remain visible here for audit and reference.</p>
        </div>
        <span className="rh-admin-count">{payments.filter(p=>p.status!=="pending").length} reviewed</span>
      </div>
      <div className="rh-admin-section-body">
        {payments.filter(p=>p.status!=="pending").length===0?<div className="rh-empty">No reviewed deposits yet.</div>:payments.filter(p=>p.status!=="pending").map(p=>{
          const customer=customers.find((c)=>c.id===p.user_id);
          return <div className="admin-list-item" key={p.id}>
            <div>
              <strong>{p.payment_type==="wallet_deposit"||String(p.transaction_reference||"").startsWith("WALLET_DEPOSIT:")?"Wallet Deposit":planLabel(p.plans)}</strong>
              <p className="muted">Customer: {customer?.full_name||p.user_id||"Unknown"}</p>
              <p className="muted">Customer ID: {p.user_id||"—"}</p>
              <p className="muted">Amount: Rs {Number(p.amount||0).toLocaleString()}</p>
              <p className="muted">Reviewed: {p.reviewed_at?new Date(p.reviewed_at).toLocaleString():"—"}</p>
            </div>
            <span className={p.status==="approved"?"status":"error"}>{p.status}</span>
          </div>
        })}
      </div>
    </section>

    {/* WITHDRAWAL REQUESTS */}
    <section id="admin-withdrawal-requests" className="rh-admin-section">
      <div className="rh-admin-section-head">
        <div>
          <div className="rh-section-label"><DollarSign size={13}/> WITHDRAWAL REQUESTS</div>
          <h2>Customer withdrawal requests</h2>
          <p>Pending requests with complete customer payment-account details. Approve or reject each request.</p>
        </div>
        <span className="rh-admin-count">{pendingWithdrawals.length} pending</span>
      </div>
      <div className="rh-admin-section-body">
        {pendingWithdrawals.length===0?<div className="rh-empty">No pending withdrawal requests.</div>:pendingWithdrawals.map(w=>{
          const amount=Number(w.amount||0);
          const commission=Number(w.admin_commission||amount*(Number(w.commission_percent??w.commission_rate??commissionRate)/100));
          const receives=Number(w.customer_receives||amount-commission);
          const details=decodeWithdrawalAccountDetails(w);
          const customer=customers.find(c=>c.id===(w.customer_id||w.user_id));
          return <div className="admin-plan" key={w.id}>
            <div className="plan-heading">
              <div><span className="eyebrow">PENDING WITHDRAWAL</span><h2>{amount.toLocaleString()} AC</h2></div>
              <span className="pill">Pending</span>
            </div>
            <div className="notice">
              <p><strong>Customer name:</strong> {customer?.full_name||"Unknown customer"}</p>
              <p><strong>Customer email:</strong> {customer?.email||"—"}</p>
              <p><strong>Customer ID:</strong> {w.customer_id||w.user_id||"—"}</p>
              <p><strong>Payment account:</strong> {w.payment_method||details.method||"—"}</p>
              <p><strong>Account holder name:</strong> {w.account_holder||details.holderName||"—"}</p>
              <p><strong>Account number:</strong> {w.account_number||details.accountNumber||"—"}</p>
              <p><strong>Requested amount:</strong> {amount.toLocaleString()} AC</p>
              <p><strong>Requested:</strong> {w.created_at?new Date(w.created_at).toLocaleString():"—"}</p>
            </div>
            <div className="hero-actions">
              <button className="btn primary" type="button" disabled={processingWithdrawal===w.id} onClick={()=>approveWithdrawal(w)}><Check size={16}/>{processingWithdrawal===w.id?"Processing...":"Approve Withdrawal"}</button>
              <button className="btn secondary" type="button" disabled={processingWithdrawal===w.id} onClick={()=>rejectWithdrawal(w)}><XCircle size={16}/>Reject Withdrawal</button>
            </div>
          </div>
        })}
      </div>
    </section>

    {/* APPROVED WITHDRAWALS */}
    <section id="admin-approved-withdrawals" className="rh-admin-section">
      <div className="rh-admin-section-head">
        <div>
          <div className="rh-section-label"><BadgeCheck size={13}/> APPROVED WITHDRAWALS</div>
          <h2>Approved withdrawal history</h2>
          <p>Approved AC withdrawals and customer payout account details.</p>
        </div>
        <span className="rh-admin-count">{approvedWithdrawals.length} approved</span>
      </div>
      <div className="rh-admin-section-body">
        {approvedWithdrawals.length===0?<div className="rh-empty">No approved withdrawals yet.</div>:approvedWithdrawals.map(w=>{
          const amount=Number(w.amount||0);
          const rate=Number(w.commission_percent??w.commission_rate??commissionRate);
          const commission=Number(w.admin_commission||amount*rate/100);
          const receives=Number(w.customer_receives||amount-commission);
          const details=decodeWithdrawalAccountDetails(w);
          const customer=customers.find(c=>c.id===(w.customer_id||w.user_id));
          return <div className="admin-list-item" key={w.id}>
            <div>
              <strong>Rs {amount.toLocaleString()} · {customer?.full_name||"Unknown customer"}</strong>
              <p className="muted">Customer ID: {w.customer_id||w.user_id||"—"}</p>
              <p className="muted">Account: {details.method||"—"} · Holder: {details.holderName||"—"} · Number: {details.accountNumber||"—"}</p>
              <p className="muted">Approved withdrawal: {amount.toLocaleString()} AC · No commission.</p>
              <p className="muted">Approved: {w.reviewed_at?new Date(w.reviewed_at).toLocaleString():"—"}</p>
            </div>
            <span className="status">Approved</span>
          </div>
        })}
      </div>
    </section>

    {/* REJECTED WITHDRAWALS */}
    <section id="admin-rejected-withdrawals" className="rh-admin-section">
      <div className="rh-admin-section-head">
        <div>
          <div className="rh-section-label"><XCircle size={13}/> REJECTED WITHDRAWALS</div>
          <h2>Rejected withdrawal history</h2>
          <p>Rejected requests remain visible so the administrator can review the complete withdrawal history.</p>
        </div>
        <span className="rh-admin-count">{rejectedWithdrawals.length} rejected</span>
      </div>
      <div className="rh-admin-section-body">
        {rejectedWithdrawals.length===0?<div className="rh-empty">No rejected withdrawals yet.</div>:rejectedWithdrawals.map(w=>{
          const amount=Number(w.amount||0);
          const details=decodeWithdrawalAccountDetails(w);
          const customer=customers.find(c=>c.id===(w.customer_id||w.user_id));
          return <div className="admin-list-item" key={w.id}>
            <div>
              <strong>Rs {amount.toLocaleString()} · {customer?.full_name||"Unknown customer"}</strong>
              <p className="muted">Customer ID: {w.customer_id||w.user_id||"—"}</p>
              <p className="muted">Account: {details.method||"—"} · Holder: {details.holderName||"—"} · Number: {details.accountNumber||"—"}</p>
              <p className="muted">Requested: {w.created_at?new Date(w.created_at).toLocaleString():"—"} · Rejected: {w.reviewed_at?new Date(w.reviewed_at).toLocaleString():"—"}</p>
            </div>
            <span className="error">Rejected</span>
          </div>
        })}
      </div>
    </section>

    {/* COMMISSIONS */}
    <section id="admin-commission" className="rh-admin-section">
      <div className="rh-admin-section-head">
        <div>
          <div className="rh-section-label"><BarChart3 size={13}/> WEBSITE MANAGEMENT FEE</div>
          <h2>Website management fee</h2>
          <p>Set the fee charged on approved withdrawals. The administrator can change it anytime from 5% to 20%.</p>
        </div>
        <span className="rh-admin-count">5%–20%</span>
      </div>
      <div className="rh-admin-section-body">
        <div className="rh-settings-grid">
          <div className="rh-setting-card">
            <span className="eyebrow">CURRENT MANAGEMENT FEE</span>
            <h3>Current rate</h3>
            <div className="big">{commissionRate}%</div>
            <p className="muted">Allowed: {MIN_ADMIN_COMMISSION_RATE}%–{MAX_ADMIN_COMMISSION_RATE}%.</p>
            <label>Management fee (%)<input type="number" min={MIN_ADMIN_COMMISSION_RATE} max={MAX_ADMIN_COMMISSION_RATE} step="1" value={commissionRate} onChange={(e)=>setCommissionRate(Number(e.target.value))}/></label>
            <button className="btn primary full" type="button" disabled={savingCommission} onClick={saveCommissionRate}>{savingCommission?"Saving...":"Save Management Fee"}</button>
          </div>
        </div>
        <div className="notice"><strong>Current totals:</strong> Today Rs {todayCommission.toLocaleString()} · Total approved withdrawal management fees Rs {totalCommission.toLocaleString()}.</div>
      </div>
    </section>

    {/* PAYMENT METHODS */}
    <section id="admin-payment-methods" className="rh-admin-section">
      <div className="rh-admin-section-head">
        <div>
          <div className="rh-section-label"><Wallet size={13}/> PAYMENT SETTINGS</div>
          <h2>Customer deposit payment methods</h2>
          <p>Add, edit, activate or deactivate JazzCash, Easypaisa, bank and other payment methods.</p>
        </div>
        <span className="rh-admin-count">{paymentMethods.length} methods</span>
      </div>
      <div className="rh-admin-section-body">
        {paymentMethods.length===0&&<div className="rh-empty">No payment methods yet.</div>}
        {paymentMethods.map(method=>
          <div className="admin-plan" key={method.id}>
            <div className="plan-heading">
              <div><span className="eyebrow">PAYMENT METHOD</span><h2>{method.name}</h2></div>
              <label className="checkbox-row"><input type="checkbox" checked={Boolean(method.is_active)} onChange={(e)=>updateMethodLocal(method.id,"is_active",e.target.checked)}/> Active</label>
            </div>
            <label>Method name<input type="text" value={method.name||""} onChange={(e)=>updateMethodLocal(method.id,"name",e.target.value)}/></label>
            <label>Account name<input type="text" value={method.account_name||""} onChange={(e)=>updateMethodLocal(method.id,"account_name",e.target.value)}/></label>
            <label>Account number<input type="text" value={method.account_number||""} onChange={(e)=>updateMethodLocal(method.id,"account_number",e.target.value)}/></label>
            <label>Instructions<textarea rows="3" value={method.instructions||""} onChange={(e)=>updateMethodLocal(method.id,"instructions",e.target.value)}/></label>
            <div className="hero-actions">
              <button className="btn primary" type="button" disabled={savingMethod===method.id} onClick={()=>saveMethod(method)}><Save size={16}/>{savingMethod===method.id?"Saving...":"Save Method"}</button>
              <button className="btn secondary" type="button" onClick={()=>deletePaymentMethod(method)}><XCircle size={16}/>Delete</button>
            </div>
          </div>
        )}
        <div className="admin-plan">
          <div className="rh-section-label"><Plus size={13}/> ADD ANOTHER METHOD</div>
          <h2>New payment method</h2>
          <label>Method name<input type="text" placeholder="e.g. Easypaisa" value={newMethod.name} onChange={(e)=>setNewMethod(c=>({...c,name:e.target.value}))}/></label>
          <label>Account name<input type="text" value={newMethod.account_name} onChange={(e)=>setNewMethod(c=>({...c,account_name:e.target.value}))}/></label>
          <label>Account number<input type="text" value={newMethod.account_number} onChange={(e)=>setNewMethod(c=>({...c,account_number:e.target.value}))}/></label>
          <label>Instructions<textarea rows="3" value={newMethod.instructions} onChange={(e)=>setNewMethod(c=>({...c,instructions:e.target.value}))}/></label>
          <button className="btn primary full" type="button" onClick={addPaymentMethod}><Plus size={16}/>Add Payment Method</button>
        </div>
      </div>
    </section>

    {/* ADMIN ACCOUNT */}
    <section id="admin-account" className="rh-admin-section">
      <div className="rh-admin-section-head">
        <div>
          <div className="rh-section-label"><ShieldCheck size={13}/> ADMIN PROFILE</div>
          <h2>Administrator account</h2>
          <p>Authenticated administrator information and platform control access.</p>
        </div>
      </div>
      <div className="rh-admin-section-body">
        <div className="notice">
          <p><strong>Email:</strong> {user?.email||"—"}</p>
          <p><strong>Role:</strong> {profile?.role||"admin"}</p>
          <p><strong>Access:</strong> Full TA777Gaming administrator controls</p>
        </div>
      </div>
    </section>
  </section>;

}


/* =========================================================
   AC TOKEN MULTI-GAME CENTER
   Wallet debits and game outcomes are settled by secure database RPCs.
========================================================= */
const AC_GAMES = {
  graph: { title: "Graph Game", subtitle: "Watch the graph rise. Cash out before the random reset." },
  horse: { title: "Horse Racing", subtitle: "Choose a horse during the 10-second betting window." },
  spin: { title: "Spin Wheel", subtitle: "Spin the 8-part wheel with your AC tokens." },
  dragonTiger: { title: "Dragon vs Tiger", subtitle: "Choose Dragon 🐉 or Tiger 🐅. A server-side random result decides the winner." }
};
const SPIN_COST = 100;
const SPIN_SEGMENTS = [
  {segment:1,prize:0,label:"0",color:"#ef476f"},
  {segment:2,prize:50,label:"50",color:"#ffd166"},
  {segment:3,prize:0,label:"0",color:"#06d6a0"},
  {segment:4,prize:100,label:"100",color:"#118ab2"},
  {segment:5,prize:0,label:"0",color:"#8b5cf6"},
  {segment:6,prize:150,label:"150",color:"#f97316"},
  {segment:7,prize:0,label:"0",color:"#14b8a6"},
  {segment:8,prize:0,label:"Try again",color:"#db2777"}
];
const ordinal = n => n===1?"1st":n===2?"2nd":n===3?"3rd":`${n}th`;
function raceRankings(horses, round) {
  if (!round?.outcome) return [];
  const winner=horses.find(h=>h.id===round.outcome);
  if (!winner) return [];
  const seed=String(round.id||"race");
  const score=id=>{let h=2166136261;for(const c of `${seed}:${id}`){h^=c.charCodeAt(0);h=Math.imul(h,16777619);}return h>>>0;};
  return [winner,...horses.filter(h=>h.id!==winner.id).sort((a,b)=>score(a.id)-score(b.id))];
}

function DragonArt(){return <svg className="dt-real-art" viewBox="0 0 420 320" role="img" aria-label="Dragon">
  <defs><linearGradient id="dtDragon" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#7cff79"/><stop offset=".45" stopColor="#16b957"/><stop offset="1" stopColor="#075b35"/></linearGradient><linearGradient id="dtDragonHorn" x1="0" y1="0" x2="1" y2="1"><stop stopColor="#ffe28a"/><stop offset="1" stopColor="#c48b22"/></linearGradient></defs>
  <path d="M85 236 C38 206 34 137 78 91 C103 64 139 53 174 61 C151 34 165 16 190 8 C189 33 207 47 225 57 C253 28 288 31 313 52 C292 60 280 76 276 96 C320 107 349 137 354 171 C360 217 327 252 287 258 C250 264 219 247 199 225 C174 267 124 271 85 236Z" fill="url(#dtDragon)" stroke="#063d27" strokeWidth="8"/>
  <path d="M95 130 C118 93 164 82 207 101 C229 111 246 128 254 149 C225 157 202 176 192 202 C168 190 147 169 137 144 C124 150 109 146 95 130Z" fill="#22c968" stroke="#063d27" strokeWidth="7"/>
  <path d="M220 113 C243 78 283 73 315 94 C294 101 282 116 277 135 C258 129 239 121 220 113Z" fill="#0b7440"/>
  <path d="M276 95 L305 61 L317 101 M295 101 L337 78 L326 116" fill="url(#dtDragonHorn)" stroke="#8e681c" strokeWidth="6"/>
  <path d="M244 154 C272 147 298 155 312 174 C294 193 267 196 244 185Z" fill="#e6f4da" stroke="#063d27" strokeWidth="6"/>
  <path d="M248 175 C266 188 288 188 305 177" fill="none" stroke="#ef4b42" strokeWidth="9" strokeLinecap="round"/>
  <circle cx="271" cy="142" r="10" fill="#101c17"/><circle cx="274" cy="139" r="3.5" fill="#fff"/>
  <path d="M110 103 L72 58 L121 72 L105 29 L153 68" fill="none" stroke="#1b9b50" strokeWidth="15" strokeLinecap="round"/>
  <path d="M115 212 C89 247 91 281 119 297 M177 217 C160 260 169 292 198 305 M281 205 C308 231 313 264 298 292" fill="none" stroke="#075b35" strokeWidth="18" strokeLinecap="round"/>
  <g fill="#8df58a" opacity=".8"><circle cx="136" cy="116" r="4"/><circle cx="154" cy="128" r="4"/><circle cx="172" cy="140" r="4"/><circle cx="190" cy="151" r="4"/><circle cx="208" cy="162" r="4"/></g>
</svg>}
function TigerArt(){return <svg className="dt-real-art" viewBox="0 0 420 320" role="img" aria-label="Tiger">
  <defs><linearGradient id="dtTiger" x1="0" y1="0" x2="1" y2="1"><stop stopColor="#ffd84a"/><stop offset=".55" stopColor="#f28b18"/><stop offset="1" stopColor="#b83d0b"/></linearGradient></defs>
  <path d="M62 235 C42 198 51 151 79 119 C103 92 132 80 168 82 C184 49 214 30 249 38 C285 46 310 75 314 109 C346 121 365 148 361 179 C356 219 320 249 281 254 C252 258 225 247 204 230 C181 263 139 275 101 261 C82 254 69 246 62 235Z" fill="url(#dtTiger)" stroke="#51240a" strokeWidth="8"/>
  <path d="M170 83 C178 56 202 42 227 47 C253 52 272 73 272 99 C270 127 249 149 220 151 C191 153 169 132 166 107Z" fill="#f6b52c" stroke="#51240a" strokeWidth="7"/>
  <path d="M177 88 L155 62 L187 70 M216 60 L211 30 L232 56 M250 70 L275 43 L272 79" fill="#f8c33a" stroke="#51240a" strokeWidth="6"/>
  <path d="M179 113 C194 100 214 97 232 103 C249 108 258 121 260 135 C241 149 215 154 191 145 C181 137 176 126 179 113Z" fill="#f8ead1" stroke="#51240a" strokeWidth="6"/>
  <path d="M190 131 C207 142 229 142 248 132" fill="none" stroke="#b92d18" strokeWidth="10" strokeLinecap="round"/>
  <circle cx="197" cy="102" r="10" fill="#15100a"/><circle cx="247" cy="103" r="10" fill="#15100a"/><circle cx="199" cy="99" r="3.5" fill="#fff"/><circle cx="249" cy="100" r="3.5" fill="#fff"/>
  <g stroke="#4a1d08" strokeWidth="13" strokeLinecap="round"><path d="M113 100 L139 128"/><path d="M96 122 L128 144"/><path d="M82 151 L120 164"/><path d="M278 116 L304 91"/><path d="M295 139 L329 124"/><path d="M299 166 L341 160"/></g>
  <path d="M100 214 C76 243 74 274 96 294 M154 224 C142 259 150 286 176 304 M257 221 C279 254 281 282 265 302" fill="none" stroke="#8d320b" strokeWidth="19" strokeLinecap="round"/>
  <path d="M315 202 C351 215 370 198 378 173" fill="none" stroke="#f28b18" strokeWidth="17" strokeLinecap="round"/>
</svg>}

function MultiGameCenter({ user }) {
  const [gameKey,setGameKey]=useState("graph");
  const [round,setRound]=useState(null);
  const [balance,setBalance]=useState(0);
  const [stake,setStake]=useState("70");
  const [selection,setSelection]=useState("thunder");
  const [dragonTigerSelection,setDragonTigerSelection]=useState("");
  const [busy,setBusy]=useState(false);
  const [notice,setNotice]=useState("");
  const [error,setError]=useState("");
  const [bets,setBets]=useState([]);
  const [graphBet,setGraphBet]=useState(null);
  const [graphNow,setGraphNow]=useState(Date.now());
  const [musicOn,setMusicOn]=useState(false);
  const [musicVolume,setMusicVolume]=useState(22);
  const musicAudioRef=useRef(null);
  const [spinResult,setSpinResult]=useState(null);
  const [freeSpins,setFreeSpins]=useState(0);
  const [spinStartedAt,setSpinStartedAt]=useState(0);
  const [spinAngle,setSpinAngle]=useState(0);
  const [countdownNow,setCountdownNow]=useState(Date.now());
  const game=AC_GAMES[gameKey];
  const horses=[
    {id:"thunder",label:"Thunder",color:"#ef4444",filter:"sepia(1) saturate(7) hue-rotate(315deg)",emoji:"🐎"},
    {id:"lightning",label:"Lightning",color:"#38bdf8",filter:"sepia(1) saturate(8) hue-rotate(165deg)",emoji:"🐎"},
    {id:"golden_star",label:"Golden Star",color:"#facc15",filter:"sepia(1) saturate(5) hue-rotate(2deg)",emoji:"🐎"},
    {id:"shadow",label:"Shadow",color:"#a78bfa",filter:"grayscale(1) brightness(.58) sepia(.35) hue-rotate(220deg) saturate(3)",emoji:"🐎"},
    {id:"emerald",label:"Emerald",color:"#10b981",filter:"sepia(1) saturate(7) hue-rotate(75deg)",emoji:"🐎"}
  ];
  const dragonTigerAnimals=[
    {id:"dragon",label:"DRAGON",emoji:"🐉",color:"#ef4444"},
    {id:"tiger",label:"TIGER",emoji:"🐅",color:"#f59e0b"}
  ];
  function startGameMusic(){
    try{
      const C=window.AudioContext||window.webkitAudioContext;if(!C)return;
      const ctx=musicAudioRef.current?.ctx||new C();
      if(ctx.state==='suspended')ctx.resume();
      if(musicAudioRef.current?.timer)return;
      const master=ctx.createGain();master.gain.value=(musicVolume/100)*0.035;master.connect(ctx.destination);
      const notes=[110,130.81,146.83,164.81,196,164.81,146.83,130.81];let i=0;
      const tick=()=>{if(!musicAudioRef.current)return;const osc=ctx.createOscillator(),g=ctx.createGain();osc.type='triangle';osc.frequency.value=notes[i++%notes.length];g.gain.setValueAtTime(0.0001,ctx.currentTime);g.gain.exponentialRampToValueAtTime(0.7,ctx.currentTime+0.03);g.gain.exponentialRampToValueAtTime(0.0001,ctx.currentTime+0.42);osc.connect(g);g.connect(master);osc.start();osc.stop(ctx.currentTime+0.45);};
      musicAudioRef.current={ctx,master,timer:setInterval(tick,430)};tick();
    }catch(e){console.warn('Game music unavailable',e);}
  }
  function stopGameMusic(){const a=musicAudioRef.current;if(!a)return;clearInterval(a.timer);try{a.master.disconnect();}catch{}musicAudioRef.current=null;}
  function toggleGameMusic(){setMusicOn(v=>{const n=!v;if(n)setTimeout(startGameMusic,0);else stopGameMusic();return n;});}
  useEffect(()=>()=>stopGameMusic(),[]);
  useEffect(()=>{if(musicAudioRef.current?.master){musicAudioRef.current.master.gain.setTargetAtTime((musicVolume/100)*0.035,musicAudioRef.current.ctx.currentTime,.05);}},[musicVolume]);

  async function refresh(){
    const b=await supabase.rpc("ac_get_balance");if(b.error)throw b.error;setBalance(Number(b.data||0));
    if(gameKey==="graph"){
      const r=await supabase.rpc("ac_graph_current_round");if(r.error)throw r.error;setRound(r.data||null);
      if(r.data?.id){const q=await supabase.from("ac_graph_bets").select("id,stake,status,cashout_multiplier,payout,created_at,user_id").eq("round_id",r.data.id).eq("user_id",user.id).order("created_at",{ascending:false}).limit(1);if(!q.error)setGraphBet((q.data||[]).find(x=>x.status==="active")||null);}
    }else if(gameKey==="horse"){
      const r=await supabase.rpc("ac_horse_current_round");if(r.error)throw r.error;setRound(r.data||null);
      if(r.data?.id){const q=await supabase.from("ac_game_bets").select("id,selection,stake,status,payout,created_at,user_id").eq("round_id",r.data.id).eq("user_id",user.id).order("created_at",{ascending:false}).limit(50);if(!q.error)setBets(q.data||[]);}
    }else if(gameKey==="dragonTiger"){
      const r=await supabase.rpc("ac_dragon_tiger_current_round");if(r.error)throw r.error;setRound(r.data||null);
      if(r.data?.id){const q=await supabase.from("ac_dragon_tiger_bets").select("id,selection,stake,status,payout,created_at").eq("round_id",r.data.id).eq("user_id",user.id).order("created_at",{ascending:false}).limit(50);if(!q.error)setBets(q.data||[]);}
    }else{
      const q=await supabase.from("ac_spin_rounds").select("id,user_id,stake,segment,prize_tokens,payout,is_free_spin,created_at").eq("user_id",user.id).order("created_at",{ascending:false}).limit(1).maybeSingle();
      if(!q.error&&q.data)setSpinResult(q.data);
      const free=await supabase.rpc("ac_spin_free_spins");if(!free.error)setFreeSpins(Number(free.data||0));
    }
  }
  useEffect(()=>{let live=true;setRound(null);setError("");setNotice("");setGraphBet(null);setBets([]);setSelection("");setDragonTigerSelection("");setSpinStartedAt(0);(async()=>{try{await refresh();}catch(e){if(live)setError(e?.message||"Could not load games. Apply the supplied SQL migration first.");}})();const poll=setInterval(()=>{refresh().catch(e=>{if(live)setError(e?.message||"Refresh failed.");});},1000);return()=>{live=false;clearInterval(poll);};},[gameKey,user.id]);
  useEffect(()=>{const t=setInterval(()=>{const n=Date.now();setGraphNow(n);setCountdownNow(n);},100);return()=>clearInterval(t);},[]);
  useEffect(()=>{if(!round?.betting_ends_at||round.phase!=="betting")return;const ms=new Date(round.betting_ends_at).getTime()-Date.now();if(ms>0){const t=setTimeout(()=>refresh().catch(()=>{}),ms+50);return()=>clearTimeout(t);}},[round?.id,round?.betting_ends_at,round?.phase]);
  async function placeBet(){
    setBusy(true);setError("");setNotice("");
    try{
      const amount=gameKey==="spin"?SPIN_COST:Number(stake);
      const minimum=70;
      if(gameKey!=="spin"&&(!Number.isFinite(amount)||amount<minimum))throw new Error("Minimum bet is 70 AC.");
      if(gameKey==="spin"&&freeSpins<=0&&balance<SPIN_COST)throw new Error("A paid spin costs exactly 100 AC. Your balance is too low.");
      if(gameKey!=="spin"&&amount>balance)throw new Error("Insufficient AC token balance.");
      if(gameKey==="graph"){
        const result=await supabase.rpc("ac_graph_join",{p_stake:amount});if(result.error)throw result.error;setGraphBet(result.data||null);setNotice(`Joined Graph Game with ${amount} AC.`);
      }else if(gameKey==="horse"){
        if(!selection)throw new Error("Select a horse before placing your bet.");
        const result=await supabase.rpc("ac_horse_place_bet",{p_selection:selection,p_stake:amount});if(result.error)throw result.error;setNotice(`Bet ${amount} AC on ${horses.find(x=>x.id===selection)?.label||selection}.`);
      }else if(gameKey==="dragonTiger"){
        if(!dragonTigerSelection)throw new Error("Select Dragon 🐉 or Tiger 🐅 before placing your bet.");
        const result=await supabase.rpc("ac_dragon_tiger_place_bet",{p_selection:dragonTigerSelection,p_stake:amount});if(result.error)throw result.error;setNotice(`Bet ${amount} AC on ${dragonTigerAnimals.find(x=>x.id===dragonTigerSelection)?.label||dragonTigerSelection}.`);
      }else{
        const useFreeSpin=freeSpins>0;
        const result=await supabase.rpc("ac_spin_play",{p_stake:SPIN_COST,p_use_free_spin:useFreeSpin});if(result.error)throw result.error;
        const d=Array.isArray(result.data)?result.data[0]:result.data;if(!d?.segment)throw new Error("Spin result was not returned by the server.");
        setSpinResult(d);setFreeSpins(Number(d.free_spins_remaining||0));setSpinStartedAt(Date.now());const center=(Number(d.segment)-0.5)*45;const delta=(360-center-(spinAngle%360)+360)%360;setSpinAngle(spinAngle+2160+delta);setNotice(useFreeSpin?"Your free retry is spinning. The result will be revealed when the wheel stops.":"Your 100 AC spin is underway. The result will be revealed when the wheel stops.");
      }
      await refresh();
    }catch(e){setError(e?.message||"Bet could not be placed.");}finally{setBusy(false);}
  }
  async function cashOut(){if(!graphBet)return;setBusy(true);setError("");setNotice("");try{const result=await supabase.rpc("ac_graph_cashout",{p_bet_id:graphBet.id});if(result.error)throw result.error;const d=Array.isArray(result.data)?result.data[0]:result.data;setNotice(`Cashed out at ${Number(d?.cashout_multiplier||0).toFixed(2)}× · ${Number(d?.payout||0).toFixed(2)} AC paid.`);setGraphBet(null);await refresh();}catch(e){setError(e?.message||"Cash out failed or graph already reset.");}finally{setBusy(false);}}
  const roundDeadline=round?.phase==="betting"?round?.betting_ends_at:round?.phase==="racing"?round?.race_ends_at:round?.cooldown_ends_at;
  const seconds=roundDeadline?Math.max(0,Math.ceil((new Date(roundDeadline).getTime()-countdownNow)/1000)):0;
  const started=round?.started_at?new Date(round.started_at).getTime():Date.now();
  const elapsed=Math.max(0,(graphNow-started)/1000);
  const graphTarget=Math.min(10,Math.max(0.1,Number(round?.crash_multiplier||10)));
  const multiplier=round?.status==="crashed"?Number(round.crash_multiplier||0.1):round?.phase==="betting"?0.1:Math.min(graphTarget,Math.round((0.1+Math.floor(elapsed/0.5)*0.1)*10)/10);
  const rankings=raceRankings(horses,round);
  const spinElapsed=spinStartedAt?graphNow-spinStartedAt:10000;
  const spinAnimating=Boolean(spinStartedAt&&spinElapsed<10000);
  const spinRevealed=Boolean(spinResult&&!spinAnimating);
  const dragonTigerResult=round?.outcome;
  return <section className="page-section ac-games-page">
    <div className="section-heading game-center-heading"><span className="eyebrow">TA777 · AC TOKEN ARENA</span><h1>Game Center</h1><p>Premium live gaming arena · AC tokens</p><div className="dt-music-bar"><button type="button" onClick={toggleGameMusic}>{musicOn?"🔊 GAMING MUSIC ON":"🎵 TURN GAMING MUSIC ON"}</button><label>VOL <input type="range" min="0" max="100" value={musicVolume} onChange={e=>setMusicVolume(Number(e.target.value))}/></label><small>Tap the button once to start music on mobile browsers.</small></div></div>
    <div className="ac-games-tabs">
      <button aria-label="Graph Game" title="Graph Game" className={gameKey==="graph"?"active":""} onClick={()=>setGameKey("graph")}><span className="ac-game-tab-icon">📈</span><span className="ac-game-tab-multiplier">10×</span></button>
      <button aria-label="Horse Racing" title="Horse Racing" className={gameKey==="horse"?"active":""} onClick={()=>setGameKey("horse")}><span className="ac-game-tab-icon">🏇</span></button>
      <button aria-label="Spin Wheel" title="Spin Wheel" className={gameKey==="spin"?"active":""} onClick={()=>setGameKey("spin")}><span className="ac-game-tab-icon">🎡</span></button>
      <button aria-label="Dragon vs Tiger" title="Dragon vs Tiger" className={gameKey==="dragonTiger"?"active":""} onClick={()=>setGameKey("dragonTiger")}><span className="ac-game-tab-icon">🐉</span><span className="ac-game-tab-icon">🐅</span></button>
    </div>
    <div className="ac-games-layout">
      <div className="dashboard-card ac-game-main">
        <div className="ac-game-top"><div><span className="eyebrow">{gameKey==="graph"?"📈 10× GRAPH":gameKey==="horse"?"🏇 HORSE RACING":gameKey==="spin"?"🎡 SPIN WHEEL":"🐉 DRAGON VS TIGER 🐅"}</span><h2>{game.subtitle}</h2></div><div className="ac-balance"><small>AC BALANCE</small><strong>{balance.toLocaleString(undefined,{maximumFractionDigits:2})} AC</strong></div></div>
        {gameKey==="graph"? <>
          <div className="ac-round-banner"><span><i className="live-dot">●</i> {round?.phase==="betting"?"BETTING OPEN":round?.status==="crashed"?"ROUND RESET":"MULTIPLIER LIVE"}</span><strong>{round?.phase==="betting"?`${seconds}s`:`${multiplier.toFixed(1)}×`}</strong><small>{round?.phase==="betting"?"Place your bet during this 10-second window. Bets close when the multiplier starts.":round?.status==="crashed"?"Round ended. The next betting window opens shortly.":"Cash out before the random reset. Multiplier rises by 0.1× every 0.5 seconds, up to 10.0×."}</small></div>
          <div className="ac-multiplier-display" role="status" aria-live="polite"><div className="ac-multiplier-caption">CURRENT MULTIPLIER</div><div className={`ac-multiplier-number ${round?.phase==="running"?"is-running":""}`}>{multiplier.toFixed(1)}<span>×</span></div><div className="ac-multiplier-steps">0.1× <span>→</span> 0.2× <span>→</span> 0.3× <span>→</span> … <span>→</span> 10.0×</div></div>
          <div className="ac-bet-row"><label>Bet amount (AC)<input type="number" min="70" step="1" value={stake} onChange={e=>setStake(e.target.value)} disabled={!!graphBet||round?.phase!=="betting"}/><small>Minimum 70 AC · wallet balance applies.</small></label>{!graphBet?<button className="btn primary" disabled={busy||!round||round.phase!=="betting"||seconds<=0} onClick={placeBet}>{busy?"Joining…":round?.phase==="betting"?"PLACE BET":"BETTING CLOSED"}</button>:<button className="btn primary" disabled={busy||round?.phase!=="running"||round?.status!=="active"} onClick={cashOut}>{busy?"Cashing out…":round?.phase==="betting"?"BET PLACED · WAIT":"CASH OUT"}</button>}</div>
          {graphBet&&<div className="notice success">Active bet: {Number(graphBet.stake).toFixed(2)} AC · current cash-out value {(Number(graphBet.stake)*multiplier).toFixed(2)} AC.</div>}
        </>:gameKey==="horse"? <>
          <div className="ac-round-banner"><span><i className="live-dot">●</i> RACE ROUND {round?.id?String(round.id).slice(0,8):"—"}</span><strong>{round?.phase==="betting"?`${seconds}s`:round?.phase==="racing"?`${seconds}s`:"NEXT"}</strong><small>{round?.phase==="betting"?"BETTING OPEN — tap a horse below, then place your AC bet.":round?.phase==="racing"?"RACE IN PROGRESS — betting is closed.":round?.phase==="cooldown"?"RACE FINISHED — next race begins after the break.":"Loading race status…"}</small></div>
          {round?.phase==="cooldown"&&rankings.length>0&&<div className="ac-race-winner" role="status">🏆 Results: {rankings.map((h,i)=><span key={h.id} className="ac-podium-chip">{ordinal(i+1)} {h.label}</span>)}</div>}
          <div className="ac-horse-track" aria-label="Five-horse race track">{horses.map((h,i)=>{const rankIndex=rankings.findIndex(x=>x.id===h.id);const rank=rankIndex<0?i:rankIndex;const raceStart=round?.race_started_at?new Date(round.race_started_at).getTime():0;const raceEnd=round?.race_ends_at?new Date(round.race_ends_at).getTime():raceStart+30000;const progress=round?.phase==="racing"?Math.min(1,Math.max(0,(graphNow-raceStart)/Math.max(1,raceEnd-raceStart))):0;const finishAt=round?.phase==="cooldown"?[96,92,88,84,80][rank]:10+Math.min(1,progress/(0.73+rank*0.055))*86;return <div key={h.id} className="ac-horse-lane" style={{"--horse-color":h.color}}><span className="ac-horse-label"><b>{i+1}</b> {h.label}</span><span className="ac-horse-finish" aria-hidden="true"/><span className={`ac-horse-runner ${rank===0&&round?.phase==="cooldown"?"is-winner":""}`} style={{left:`${finishAt}%`,"--horse-filter":h.filter}} aria-label={h.label}>{h.emoji}</span>{round?.phase==="cooldown"&&rankings.length>0&&<span className="ac-horse-rank-tag">{ordinal(rank+1)}</span>}</div>;})}</div>
          <div className="ac-choice-grid">{horses.map(h=><button type="button" key={h.id} className={selection===h.id?"chosen":""} onClick={()=>setSelection(h.id)} disabled={!round||round.phase!=="betting"||busy} style={{borderColor:selection===h.id?h.color:undefined,"--horse-color":h.color}}><span style={{color:h.color,fontSize:22}}>🐎</span><strong>{h.label}</strong>{selection===h.id&&<small style={{display:"block",marginTop:5,color:h.color}}>✓ SELECTED</small>}</button>)}</div>
          <div className="ac-bet-row"><label>Bet amount (AC)<input type="number" min="70" step="1" value={stake} onChange={e=>setStake(e.target.value)} disabled={!round||round.phase!=="betting"}/><small>Minimum 70 AC</small></label><button className="btn primary" disabled={busy||!round||round.phase!=="betting"||seconds<=0||!selection} onClick={placeBet}>{busy?"Placing…":selection?`BET ON ${horses.find(h=>h.id===selection)?.label.toUpperCase()}`:"SELECT A HORSE FIRST"}</button></div>
          <div className="ac-payout-note"><strong>Horse race rewards</strong><span>Multiple players can join the same race.</span><span>75% of the total bets is shared equally among distinct winning players; 25% is the website management fee.</span><span>Betting: 10 seconds · Race: 30 seconds · Break: 10 seconds.</span></div>
          <div className="ac-bet-list">{bets.map(b=><div className="ac-bet-item" key={b.id}><span>{horses.find(h=>h.id===b.selection)?.label||b.selection}</span><strong>{Number(b.stake).toLocaleString()} AC</strong><small>{b.status}{b.payout>0?` · payout ${Number(b.payout).toLocaleString()} AC`:""}</small></div>)}</div>
        </>:gameKey==="dragonTiger"? <>
          <div className="ac-round-banner"><span><i className="live-dot">●</i> {round?.phase==="betting"?"BETTING OPEN":dragonTigerResult?`WINNER: ${dragonTigerResult.toUpperCase()}`:"DRAGON VS TIGER"}</span><strong>{round?.phase==="betting"?`${seconds}s`:round?.phase==="cooldown"?"NEXT":dragonTigerResult?dragonTigerResult.toUpperCase():"—"}</strong><small>{round?.phase==="betting"?"Choose Dragon or Tiger before the countdown reaches zero.":"The winner is selected randomly by the secure server."}</small></div>
          <div className="dt-board" aria-label="Dragon versus Tiger betting board">
            {dragonTigerAnimals.map(animal=><button type="button" key={animal.id} className={`dt-animal-card ${dragonTigerSelection===animal.id?"selected":""} ${round?.outcome===animal.id?"winner":""}`} onClick={()=>round?.phase==="betting"&&!busy&&setDragonTigerSelection(animal.id)} disabled={!round||round.phase!=="betting"||busy} style={{"--animal-color":animal.color}}>
              <div className="dt-animal-art" aria-hidden="true">{animal.id==="dragon"?<DragonArt/>:<TigerArt/>}</div><div className="dt-animal-name">{animal.label}</div><div className="dt-animal-action">{dragonTigerSelection===animal.id?"✓ SELECTED":"BET HERE"}</div>{round?.outcome===animal.id&&<div className="dt-winner-badge">🏆 WINNER</div>}
            </button>)}
          </div>
          <div className="ac-bet-row"><label>Bet amount (AC)<input type="number" min="70" step="1" value={stake} onChange={e=>setStake(e.target.value)} disabled={!round||round.phase!=="betting"}/><small>Minimum 70 AC · winner payout is 2× the bet.</small></label><button className="btn primary" disabled={busy||!round||round.phase!=="betting"||seconds<=0||!dragonTigerSelection} onClick={placeBet}>{busy?"Placing…":dragonTigerSelection?`BET ON ${dragonTigerSelection.toUpperCase()}`:"SELECT DRAGON OR TIGER"}</button></div>
          {round?.phase!=="betting"&&round?.outcome&&<div className={`dt-result ${bets.some(b=>b.status==="won")?"win":""}`}><span>ROUND RESULT</span><strong>{round.outcome.toUpperCase()} {round.outcome==="dragon"?"🐉":"🐅"}</strong>{bets.filter(b=>b.status!=="active").map(b=><small key={b.id}>{b.selection.toUpperCase()}: {b.status.toUpperCase()} · {Number(b.payout||0).toLocaleString()} AC payout</small>)}</div>}
          <div className="ac-payout-note"><strong>Dragon vs Tiger rules</strong><span>Choose exactly one animal during the betting window.</span><span>If your chosen animal wins, your bet pays <b>2×</b> the bet amount.</span><span>If your chosen animal loses, the bet amount is deducted and no payout is returned.</span><span>Each round's winner is randomly selected by the server.</span></div>
          <div className="ac-bet-list">{bets.map(b=><div className="ac-bet-item" key={b.id}><span>{b.selection==="dragon"?"🐉 Dragon":"🐅 Tiger"}</span><strong>{Number(b.stake).toLocaleString()} AC</strong><small>{b.status}{b.payout>0?` · payout ${Number(b.payout).toLocaleString()} AC`:""}</small></div>)}</div>
        </>:<>
          <div className="ac-spin-stage"><div className="ac-spin-pointer" aria-hidden="true"/><div className={`ac-spin-wheel ${spinAnimating?"is-spinning":""}`} style={{transform:`rotate(${spinAngle}deg)`}} aria-label="Eight-section prize wheel">{SPIN_SEGMENTS.map(s=><span key={s.segment} className="ac-spin-segment-label" style={{transform:`rotate(${(s.segment-0.5)*45}deg) translateY(-95px) rotate(${-(s.segment-0.5)*45}deg)`}}>{s.label}</span>)}</div></div>
          <div className="ac-spin-legend">{SPIN_SEGMENTS.map(s=><span key={s.segment}><i style={{background:s.color}}/>{s.segment}. {s.label}</span>)}</div>
          <div className="ac-bet-row"><label>Spin cost<input type="text" value={freeSpins>0?"FREE RETRY":"100 AC"} readOnly/><small>Each paid spin costs exactly 100 AC. {freeSpins>0?`You have ${freeSpins} free ${freeSpins===1?"spin":"spins"} available.`:"A Try again result grants one free retry."}</small></label><button className="btn primary" disabled={busy||spinAnimating||(freeSpins<=0&&balance<SPIN_COST)} onClick={placeBet}>{busy?"Starting…":spinAnimating?"WHEEL SPINNING…":freeSpins>0?"USE FREE SPIN":"SPIN · 100 AC"}</button></div>
          {spinAnimating&&<div className="notice">Wheel is spinning… {Math.max(0,Math.ceil((10000-spinElapsed)/1000))} seconds remaining.</div>}
          {spinRevealed&&<div className={`ac-spin-result ${Number(spinResult.segment)===8?"is-retry":Number(spinResult.prize_tokens)===0?"is-zero":"is-win"}`} role="status"><small>SPIN RESULT</small><strong>{Number(spinResult.segment)===8?"Try again":`${Number(spinResult.prize_tokens||0).toLocaleString()} AC`}</strong><span>{spinResult.is_free_spin?"Free retry used":`${Number(spinResult.stake||0).toLocaleString()} AC spin cost`} · {Number(spinResult.payout||0).toLocaleString()} AC payout</span>{Number(spinResult.segment)===8&&<span>A free retry has been added to your account.</span>}</div>}
        </>}
        {notice&&<div className="notice success">{notice}</div>}{error&&<div className="notice error">{error}</div>}
      </div>
      <div className="dashboard-card"><h3>{gameKey==="graph"?"📈 Graph Game":gameKey==="horse"?"🏇 Race bets":gameKey==="dragonTiger"?"🐉🐅 Dragon vs Tiger":"🎡 Spin Wheel"}</h3>{gameKey==="graph"?<div className="ac-payout-note"><span>• Join with AC tokens</span><span>• 10-second betting window each round</span><span>• Minimum bet: 70 AC</span><span>• Multiplier rises by 0.1× every 0.5 seconds</span><span>• Random reset point from 0.1× to 10.0×</span><span>• Cash out before reset; otherwise the bet is lost</span></div>:gameKey==="horse"?<><div className="ac-bet-list">{bets.length?bets.map(b=><div className="ac-bet-item" key={b.id}><span>{horses.find(o=>o.id===b.selection)?.label||b.selection}</span><strong>{Number(b.stake).toLocaleString()} AC</strong><small>{b.status}</small></div>):<p className="muted">No bets in this race yet.</p>}</div><p className="muted ac-small">Multiple players can join each race.</p></>:gameKey==="dragonTiger"?<div className="ac-payout-note"><span>🐉 Dragon and 🐅 Tiger are the two choices.</span><span>• Betting opens for 10 seconds.</span><span>• One random winner is selected by the server.</span><span>• Winning bet payout = 2× stake.</span><span>• Losing bet is fully deducted.</span><span>• The next round starts automatically after the result break.</span></div>:<div className="ac-payout-note"><span>• Each paid spin costs exactly 100 AC.</span><span>• Wheel segments: 0, 50, 0, 100, 0, 150, 0, and Try again.</span><span>• Results are selected randomly by the server.</span><span>• Try again grants one free spin.</span><span>• Each spin animates for 10 seconds.</span></div>}</div>
    </div>
    <style>{`.ac-games-tabs{display:flex;gap:12px;margin:14px 0;flex-wrap:wrap}.ac-games-tabs button{display:flex;align-items:center;justify-content:center;gap:7px;min-width:86px;min-height:74px;border:1px solid #263553;border-radius:16px;background:#080e1a;color:#fff;cursor:pointer}.ac-games-tabs button.active{border-color:#38f2dc;background:linear-gradient(145deg,#12363b,#17112e);box-shadow:0 0 24px #00e5d433}.ac-game-tab-icon{font-size:31px}.ac-game-tab-multiplier{font-weight:1000;font-size:20px;color:#f5d37c}.ac-multiplier-display{min-height:260px;margin:14px 0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;border:1px solid rgba(197,162,75,.42);border-radius:18px;background:radial-gradient(ellipse at center,rgba(0,214,190,.13),transparent 58%),linear-gradient(145deg,#07111d,#03060c);box-shadow:inset 0 0 45px rgba(0,229,212,.045)}.ac-multiplier-caption{font-size:12px;letter-spacing:.18em;font-weight:900;color:#aab8c8}.ac-multiplier-number{font-size:clamp(64px,12vw,112px);font-weight:1000;line-height:1;color:#f5d37c;text-shadow:0 0 22px rgba(245,211,124,.22);font-variant-numeric:tabular-nums}.ac-multiplier-number span{font-size:.48em;margin-left:5px}.ac-multiplier-number.is-running{color:#36f1c5;text-shadow:0 0 24px rgba(54,241,197,.3)}.ac-multiplier-steps{font-size:14px;font-weight:800;letter-spacing:.08em;color:#8393aa}.ac-multiplier-steps span{color:#f5d37c;padding:0 5px}.ac-bet-row label small{display:block;color:#8998ae;font-size:11px;margin-top:5px}.ac-horse-runner{animation:horseGallop .18s ease-in-out infinite alternate;transform:translate(-50%,-50%) scaleX(-1);filter:var(--horse-filter,none) drop-shadow(0 2px 4px #0009);transition:left .18s linear}@keyframes horseGallop{from{margin-top:-2px}to{margin-top:4px}}@keyframes raceFieldMove{from{background-position:0 0}to{background-position:-100px 0}}.ac-horse-runner.is-winner{filter:var(--horse-filter,none) drop-shadow(0 0 9px var(--horse-color))}.ac-horse-rank-tag{position:absolute;right:10px;top:5px;color:#fff;background:#0d8b63;border-radius:6px;padding:4px 7px;font-size:10px;font-weight:900}.ac-horse-track{display:grid;gap:10px;background:linear-gradient(180deg,#09111f,#070b13);padding:16px;border-radius:16px;border:1px solid #2a4055}.ac-horse-lane{height:72px;position:relative;overflow:hidden;border-radius:10px;background:repeating-linear-gradient(90deg,#142b29 0 46px,#25443b 47px 50px);background-size:100px 100%;animation:raceFieldMove .7s linear infinite;border:1px solid #34504d}.ac-horse-label{position:absolute;left:10px;top:5px;z-index:2;font-size:11px;font-weight:900;color:var(--horse-color);background:#050b12d9;padding:4px 7px;border-radius:6px}.ac-horse-label b{display:inline-grid;place-items:center;width:18px;height:18px;border-radius:50%;background:var(--horse-color);color:#061018;margin-right:4px}.ac-horse-finish{position:absolute;right:2.5%;top:0;bottom:0;width:5px;background:repeating-linear-gradient(180deg,#fff 0 7px,#111827 7px 14px);opacity:.8}.ac-horse-runner{position:absolute;top:66%;z-index:3;font-size:34px;line-height:1;filter:var(--horse-filter,none) drop-shadow(0 2px 4px #0009)}.ac-race-winner{display:flex;flex-wrap:wrap;gap:7px;margin:12px 0;padding:15px 18px;border-radius:12px;border:1px solid #c5a24b66;background:linear-gradient(100deg,#241d0b,#0c131a);color:#f5e6b2;font-size:14px}.ac-podium-chip{padding:5px 9px;border-radius:8px;background:#0a101a;border:1px solid #4c5b6e;font-weight:800}.ac-spin-stage{height:300px;display:grid;place-items:center;position:relative;margin:12px auto 4px}.ac-spin-pointer{position:absolute;top:3px;z-index:5;width:0;height:0;border-left:15px solid transparent;border-right:15px solid transparent;border-top:0;border-bottom:30px solid #fff;filter:drop-shadow(0 3px 5px #0009)}.ac-spin-wheel{position:relative;width:250px;height:250px;border-radius:50%;border:9px solid #f5d37c;box-shadow:0 0 0 5px #101827,0 0 35px #f5d37c44;background:conic-gradient(from 0deg,#ef476f 0deg 45deg,#ffd166 45deg 90deg,#06d6a0 90deg 135deg,#118ab2 135deg 180deg,#8b5cf6 180deg 225deg,#f97316 225deg 270deg,#14b8a6 270deg 315deg,#db2777 315deg 360deg);transition:transform 10s cubic-bezier(.08,.72,.08,1)}.ac-spin-wheel:after{content:"";position:absolute;inset:42%;border-radius:50%;background:#080e1a;border:4px solid #f5d37c;box-shadow:0 0 12px #0008}.ac-spin-segment-label{position:absolute;left:calc(50% - 34px);top:calc(50% - 12px);width:68px;text-align:center;font-size:15px;font-weight:1000;color:#fff;text-shadow:0 2px 4px #000b;white-space:nowrap}.ac-spin-legend{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin:12px 0}.ac-spin-legend span{display:flex;align-items:center;gap:6px;background:#0a111e;border:1px solid #26344a;border-radius:9px;padding:8px;font-weight:800;font-size:12px}.ac-spin-legend i{width:10px;height:10px;border-radius:50%;flex:0 0 10px}.ac-spin-result{display:flex;flex-direction:column;align-items:center;gap:5px;margin-top:14px;padding:20px;border-radius:16px;border:1px solid #30c99a;background:linear-gradient(145deg,#08291f,#07111b);text-align:center}.ac-spin-result.is-zero{border-color:#ef476f;background:linear-gradient(145deg,#2a0c19,#07111b)}.ac-spin-result.is-retry{border-color:#db2777;background:linear-gradient(145deg,#310c2b,#07111b)}.ac-spin-result small{letter-spacing:.15em;font-weight:900;color:#aebbd0}.ac-spin-result strong{font-size:64px;line-height:1.1;color:#f5d37c}.ac-spin-result span{color:#d3deec;font-size:13px}.dt-board{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;margin:20px 0}.dt-animal-card{position:relative;min-height:310px;border:2px solid rgba(255,255,255,.12);border-radius:24px;background:radial-gradient(circle at 50% 28%,rgba(255,255,255,.10),transparent 34%),linear-gradient(145deg,#171225,#090914);color:#fff;cursor:pointer;overflow:hidden;transition:transform .18s ease,border-color .18s ease,box-shadow .18s ease}.dt-animal-card:before{content:"";position:absolute;inset:0;background:radial-gradient(circle at 50% 75%,var(--animal-color),transparent 62%);opacity:.16}.dt-animal-card:hover{transform:translateY(-3px)}.dt-animal-card.selected{border-color:var(--animal-color);box-shadow:0 0 28px color-mix(in srgb,var(--animal-color) 38%,transparent),inset 0 0 35px color-mix(in srgb,var(--animal-color) 12%,transparent)}.dt-animal-card.winner{box-shadow:0 0 38px color-mix(in srgb,var(--animal-color) 48%,transparent),inset 0 0 45px color-mix(in srgb,var(--animal-color) 15%,transparent)}.dt-animal-card:disabled{cursor:not-allowed}.dt-animal-art{position:relative;z-index:1;font-size:clamp(100px,17vw,170px);line-height:1;margin-top:28px;filter:drop-shadow(0 12px 15px #0009)}.dt-animal-name{position:relative;z-index:1;font-size:28px;font-weight:1000;letter-spacing:.08em;color:var(--animal-color)}.dt-animal-action{position:relative;z-index:1;margin:9px auto 0;width:max-content;padding:7px 12px;border-radius:99px;border:1px solid color-mix(in srgb,var(--animal-color) 50%,transparent);font-size:11px;font-weight:900}.dt-winner-badge{position:absolute;z-index:3;right:12px;top:12px;background:#0c1d15;border:1px solid #43d39e;color:#9ef0cf;border-radius:99px;padding:7px 10px;font-size:11px;font-weight:1000}.dt-result{display:flex;flex-direction:column;align-items:center;gap:6px;margin:14px 0;padding:20px;border-radius:16px;border:1px solid #ef536a;background:#260c15;text-align:center}.dt-result.win{border-color:#45d49d;background:#09271e}.dt-result span{font-size:10px;letter-spacing:.16em;color:#a9b5c7;font-weight:900}.dt-result strong{font-size:36px;color:#f6d785}.dt-result small{color:#dbe6f5}.ta-home-games .feature-grid{grid-template-columns:repeat(2,minmax(0,1fr))}@media(max-width:650px){.ta-home-games .feature-grid{grid-template-columns:1fr}.ac-games-tabs button{min-width:74px;min-height:68px}.ac-spin-legend{grid-template-columns:repeat(2,minmax(0,1fr))}.ac-spin-wheel{width:230px;height:230px}.ac-spin-stage{height:270px}.dt-board{grid-template-columns:1fr}.dt-animal-card{min-height:270px}.dt-animal-art{font-size:110px}.dt-animal-name{font-size:24px}}`}</style>
  </section>;
}


function ProtectedRoute({user,children}){if(!user)return <Navigate to="/login" replace/>;return children;}
function AdminRoute({user,profile,loading,children}){if(loading)return <section className="page-section"><div className="dashboard-card"><h2>Checking administrator access...</h2></div></section>;if(!user)return <Navigate to="/login" replace/>;if(profile?.role!=="admin")return <Navigate to="/dashboard" replace/>;return children;}

/* =========================================================
   APP
========================================================= */

function App(){
  const [user,setUser]=useState(null);
  const [profile,setProfile]=useState(null);
  const [loading,setLoading]=useState(true);
  const location=useLocation();

  async function loadProfile(currentUser){
    if(!currentUser){setProfile(null);return;}
    const {data,error}=await supabase.from("profiles").select("*").eq("id",currentUser.id).maybeSingle();
    if(error){console.warn("Could not load profile:",error.message);setProfile(null);}
    else setProfile(data||null);
  }

  useEffect(()=>{
    let mounted=true;
    (async()=>{
      try{
        const {data:{session}}=await supabase.auth.getSession();
        if(!mounted)return;
        const current=session?.user||null;
        setUser(current);
        if(current) await loadProfile(current);
      }catch(error){
        console.error("Session initialization failed:",error);
      }finally{
        if(mounted)setLoading(false);
      }
    })();
    const {data:{subscription}}=supabase.auth.onAuthStateChange((_event,session)=>{
      if(!mounted)return;
      const current=session?.user||null;
      setUser(current);
      if(current){
        loadProfile(current).catch(error=>console.warn("Profile refresh failed:",error));
      }else setProfile(null);
    });
    return()=>{mounted=false;subscription.unsubscribe();};
  },[]);

  const isAdmin=useMemo(()=>profile?.role==="admin",[profile]);

  let content;
  const path=location.pathname;
  if(loading){
    content=<section className="page-section"><div className="dashboard-card"><h2>Loading TA777Gaming...</h2></div></section>;
  }else if(path==="/"){
    content=<Home/>;
  }else if(path==="/plans"){
    content=<Navigate to={user?"/games":"/login"} replace/>;
  }else if(path==="/games"){
    content=user?<MultiGameCenter user={user}/>:<Navigate to="/login" replace/>;
  }else if(path==="/how-it-works"){
    content=<HowItWorks/>;
  }else if(path==="/login"){
    content=user?<Navigate to={isAdmin?"/admin":"/dashboard"} replace/>:<Auth mode="login"/>;
  }else if(path==="/register"){
    content=user?<Navigate to="/dashboard" replace/>:<Auth mode="register"/>;
  }else if(path.startsWith("/buy/") || path==="/game"){
    content=<Navigate to={user?"/games":"/login"} replace/>;
  }else if(path==="/dashboard"){
    content=user?<Dashboard user={user} profile={profile}/>:<Navigate to="/login" replace/>;
  }else if(path==="/admin"){
    content=!user?<Navigate to="/login" replace/>:profile?.role!=="admin"?<Navigate to="/dashboard" replace/>:<Admin user={user} profile={profile}/>;
  }else{
    content=<Home/>;
  }

  return <Layout user={user} isAdmin={isAdmin}>{content}</Layout>;
}

export default App;