export type Language = 'en' | 'hi' | 'hinglish';

export interface MessageInput {
  customer_ref: string;
  merchant_name: string;
  amount_paise: number;
  link: string;
}

export interface Message {
  subject: string;
  body: string;
  language: Language;
}

function rupees(paise: number): string {
  return `₹${Math.round(paise / 100).toLocaleString('en-IN')}`;
}

const BUILDERS: Record<Language, (i: MessageInput) => Message> = {
  en: (i) => ({
    language: 'en',
    subject: `Your ${i.merchant_name} payment needs re-authorisation`,
    body: [
      `Hello ${i.customer_ref},`,
      '',
      `Your ${rupees(i.amount_paise)} payment to ${i.merchant_name} could not be collected, and`,
      'your bank will not allow another attempt on the current authorisation.',
      '',
      `Re-authorise here to keep it active: ${i.link}`,
      '',
      'Short on funds? The same link lets you tell us a date, and we will wait until then.',
      'Would rather stop? The same link cancels it, and we will not contact you again.',
    ].join('\n'),
  }),

  hinglish: (i) => ({
    language: 'hinglish',
    subject: `${i.merchant_name} ka payment fail ho gaya`,
    body: [
      `Namaste ${i.customer_ref},`,
      '',
      `Aapka ${rupees(i.amount_paise)} ka payment ${i.merchant_name} ko nahi ja paya. Bank current`,
      'authorisation par dobara try karne nahi de raha.',
      '',
      `Subscription chalu rakhne ke liye yahan re-authorise karein: ${i.link}`,
      '',
      'Abhi paise nahi hain? Usi link par date bata dijiye, hum tab tak wait karenge.',
      'Band karna hai? Usi link se cancel kar dijiye, phir hum contact nahi karenge.',
    ].join('\n'),
  }),

  hi: (i) => ({
    language: 'hi',
    subject: `${i.merchant_name} का भुगतान विफल रहा`,
    body: [
      `नमस्ते ${i.customer_ref},`,
      '',
      `${i.merchant_name} को आपका ${rupees(i.amount_paise)} का भुगतान नहीं हो सका। बैंक मौजूदा`,
      'अनुमति पर दोबारा प्रयास करने की अनुमति नहीं दे रहा है।',
      '',
      `सदस्यता जारी रखने के लिए यहाँ पुनः अनुमति दें: ${i.link}`,
      '',
      'अभी पैसे नहीं हैं? उसी लिंक पर तारीख बता दीजिए, हम तब तक प्रतीक्षा करेंगे।',
      'बंद करना है? उसी लिंक से रद्द कर दीजिए, फिर हम संपर्क नहीं करेंगे।',
    ].join('\n'),
  }),
};

export function buildMessage(input: MessageInput, language: Language = 'en'): Message {
  return (BUILDERS[language] ?? BUILDERS.en)(input);
}

export function resolveLanguage(value: string | null | undefined): Language {
  const v = (value ?? '').trim().toLowerCase();
  if (v === 'hi' || v === 'hindi') return 'hi';
  if (v === 'hinglish' || v === 'en-hi') return 'hinglish';
  return 'en';
}

export const SUPPORTED_LANGUAGES: Language[] = ['en', 'hinglish', 'hi'];
