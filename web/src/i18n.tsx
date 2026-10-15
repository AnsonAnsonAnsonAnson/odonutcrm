import { createContext, useContext, useState, type ReactNode } from 'react';

type Locale = 'en' | 'zh-HK';

const dict = {
  en: {
    signInRegister: 'Sign In / Register',
    email: 'Email',
    nextStep: 'Next Step',
    tagline: 'Collect stamps. Earn free donuts.',
    codeSent: 'We sent a 6-digit code to',
    code: 'Verification code',
    verify: 'Verify',
    resend: 'Send a new code',
    changeEmail: 'Use a different email',
    signUp: 'Sign Up',
    required: 'Required',
    firstName: 'First Name',
    lastName: 'Last Name',
    mobile: 'Mobile No.',
    dob: 'Date of Birth',
    gender: 'Gender',
    male: 'Male',
    female: 'Female',
    other: 'Other',
    preferNot: 'Prefer not to say',
    referral: 'Friend’s referral code (optional)',
    optIn: 'Send me offers and news. You can turn this off any time.',
    acceptTerms: 'I agree to the terms and privacy policy',
    join: 'Join the club',
    oneMoreStep: 'One more step left!',
    addToWalletHint: "Add your membership card to your wallet app so you'll always have it with you.",
    scanByMobile: 'Scan this with your phone to add the card',
    addApple: 'Add to Apple Wallet',
    addGoogle: 'Add to Google Wallet',
    skip: 'Skip',
    claimedReward: 'You have claimed a reward!',
    claimedRewardBody: 'Find it any time under My Vouchers in your Member Center.',
    confirm: 'Confirm',
    youHave: 'YOU HAVE',
    stamps: 'Stamp(s)',
    benefits: 'Benefits',
    benefitsHint: 'Click here for more details',
    promoCode: 'Promo Code',
    history: 'History',
    myVouchers: 'My Vouchers',
    noVouchers: 'No vouchers yet. Keep collecting stamps!',
    expiringOn: 'Expiring on',
    singleUse: 'Single use only',
    showAtCounter: 'Show this code at the counter',
    showCard: 'Show this at the counter to collect stamps',
    apply: 'Apply',
    close: 'Close',
    poweredBy: 'Made with love by O! Donut',
    howItWorks: 'How it works',
    howBody: 'Show your card at the counter with every purchase to collect a stamp. Fill the card to get a free donut, then start again.',
    perks: 'Member perks',
    perkWelcome: 'A welcome treat when you join',
    perkBirthday: 'A birthday donut every year',
    perkReferral: 'A free donut when a friend you invite makes their first visit',
    enablePush: 'Turn on notifications',
    pushOn: 'Notifications are on',
    refer: 'Invite a friend',
    referBody: 'Share your link. When your friend visits for the first time, you get a free donut.',
    copy: 'Copy link',
    copied: 'Copied!',
    settings: 'Settings',
    logout: 'Log out',
    deleteAccount: 'Delete my account',
    deleteConfirm: 'This permanently deletes your card, stamps and vouchers. Continue?',
    marketing: 'Offers and news',
    walletAdded: 'In your wallet',
    stampAdded: 'Stamp added',
    used: 'Used',
    expired: 'Expired',
    inbox: 'Messages',
    noMessages: 'No messages yet. Offers and reward alerts will show up here.',
    privacy: 'Privacy policy',
    useMobile: 'Sign in with mobile number instead',
    useEmail: 'Sign in with email instead',
    mobileHint: 'For existing members. New here? Sign up with your email.',
    changeMobile: 'Use a different number',
    tier: 'Tier',
    tierNext: 'more stamps to reach',
    tierTop: 'You are at our top tier. Thank you!',
    tierWindow: 'Counts stamps from the last {d} days.',
    promoWaiting: 'Your promo code {c} will be added when you finish signing up.',
  },
  'zh-HK': {
    signInRegister: '登入 / 註冊',
    email: '電郵',
    nextStep: '下一步',
    tagline: '集印花，換免費冬甩。',
    codeSent: '我們已發送 6 位數驗證碼至',
    code: '驗證碼',
    verify: '確認',
    resend: '重新發送',
    changeEmail: '使用其他電郵',
    signUp: '註冊',
    required: '必填',
    firstName: '名字',
    lastName: '姓氏',
    mobile: '手提電話',
    dob: '出生日期',
    gender: '性別',
    male: '男',
    female: '女',
    other: '其他',
    preferNot: '不透露',
    referral: '朋友推薦碼（選填）',
    optIn: '我願意接收優惠及最新消息，可隨時取消。',
    acceptTerms: '我同意條款及私隱政策',
    join: '加入會員',
    oneMoreStep: '尚餘一步！',
    addToWalletHint: '將會員卡加入手機錢包，隨時隨地都可使用。',
    scanByMobile: '請用手機掃描以加入會員卡',
    addApple: '加入 Apple 錢包',
    addGoogle: '加入 Google 錢包',
    skip: '略過',
    claimedReward: '你已獲得獎賞！',
    claimedRewardBody: '可隨時在會員中心「我的優惠券」查看。',
    confirm: '確認',
    youHave: '你已有',
    stamps: '個印花',
    benefits: '會員禮遇',
    benefitsHint: '按此了解更多',
    promoCode: '優惠碼',
    history: '紀錄',
    myVouchers: '我的優惠券',
    noVouchers: '暫時未有優惠券，繼續集印花吧！',
    expiringOn: '到期日',
    singleUse: '只限使用一次',
    showAtCounter: '請於櫃檯出示此代碼',
    showCard: '於櫃檯出示以收集印花',
    apply: '使用',
    close: '關閉',
    poweredBy: 'O! Donut 用心製作',
    howItWorks: '使用方法',
    howBody: '每次消費時出示會員卡即可獲得一個印花。集滿即可免費換領冬甩，然後重新開始。',
    perks: '會員禮遇',
    perkWelcome: '入會迎新禮',
    perkBirthday: '每年生日冬甩',
    perkReferral: '朋友首次光臨，你可獲免費冬甩',
    enablePush: '開啟通知',
    pushOn: '已開啟通知',
    refer: '邀請朋友',
    referBody: '分享你的連結。朋友首次光臨後，你可獲免費冬甩一個。',
    copy: '複製連結',
    copied: '已複製！',
    settings: '設定',
    logout: '登出',
    deleteAccount: '刪除我的帳戶',
    deleteConfirm: '此操作將永久刪除你的會員卡、印花及優惠券。確定繼續？',
    marketing: '優惠及消息',
    walletAdded: '已加入錢包',
    stampAdded: '已加印花',
    used: '已使用',
    expired: '已過期',
    inbox: '訊息',
    noMessages: '暫時未有訊息。優惠及獎賞通知會顯示在這裡。',
    privacy: '私隱政策',
    useMobile: '改用手機號碼登入',
    useEmail: '改用電郵登入',
    mobileHint: '適用於現有會員。新會員請用電郵註冊。',
    changeMobile: '使用其他號碼',
    tier: '會員級別',
    tierNext: '個印花即可升級至',
    tierTop: '你已達最高級別，多謝支持！',
    tierWindow: '以過去 {d} 日的印花計算。',
    promoWaiting: '完成註冊後會自動使用優惠碼 {c}。',
  },
} as const;

export type Key = keyof typeof dict.en;

const Ctx = createContext<{ locale: Locale; t: (k: Key) => string; toggle: () => void }>({
  locale: 'en',
  t: (k) => dict.en[k],
  toggle: () => {},
});

function initial(): Locale {
  try {
    const saved = localStorage.getItem('locale');
    if (saved === 'en' || saved === 'zh-HK') return saved;
  } catch {}
  return navigator.language.toLowerCase().startsWith('zh') ? 'zh-HK' : 'en';
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocale] = useState<Locale>(initial);
  const toggle = () => {
    const next = locale === 'en' ? 'zh-HK' : 'en';
    setLocale(next);
    try {
      localStorage.setItem('locale', next);
    } catch {}
  };
  return <Ctx.Provider value={{ locale, t: (k) => dict[locale][k], toggle }}>{children}</Ctx.Provider>;
}

export const useI18n = () => useContext(Ctx);

export function LangButton() {
  const { locale, toggle } = useI18n();
  return (
    <button className="lang" onClick={toggle} aria-label="Change language">
      {locale === 'en' ? '中' : 'EN'}
    </button>
  );
}
