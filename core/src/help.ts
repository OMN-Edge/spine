/**
 * How Spine works, in a few short answers: what the chat's welcome offers as questions, what a tip's "Tell me more" opens, and what
 * the assistant reads with its `explain_spine` tool when someone asks how the app works rather than about their records. Fixed text,
 * written here once: the page shows it translated (the dictionaries in `web/src/i18n/` hold every string below, and
 * `i18n-coverage.test.ts` reads this list), the assistant gets the English, and showing it calls no model.
 *
 * Keep each answer true of what the code does: a change to sharing, reading or the keys that makes one false changes it here.
 */
export interface HelpTopic {
  id: string;
  /** The question as the person would ask it, for a button. */
  question: string;
  /** The answer, a paragraph each. */
  paragraphs: string[];
}

export const HELP_TOPICS: HelpTopic[] = [
  {
    id: 'adding',
    question: 'What happens to a document I add?',
    paragraphs: [
      'Add a PDF on the Upload page, or a photo of a paper document: the photo is straightened and cleaned first, and you choose how each page looks. You can also attach a file in this chat.',
      'Spine first reads the text of the pages and works out which pages belong together, so a file holding several documents becomes several. You check that grouping, and only then is each document read: its title, date, doctors, fields and results.',
      'The file you added is kept as it is, so you can always go back to the original.',
    ],
  },
  {
    id: 'grouping',
    question: 'What does checking the grouping mean?',
    paragraphs: [
      'One file often holds several documents: a scan of a whole folder, or a lab report with a letter behind it. Spine guesses where each document starts and ends, and asks you to look before it reads them.',
      'On the grouping screen you can join documents, split one, move a page or set a blank one aside. When it looks right, confirm it and the documents are read. A file of a single page has nothing to group and is read straight away.',
      'Until you confirm, those documents stay out of the timeline and search, so a wrong guess never mixes up your records.',
    ],
  },
  {
    id: 'checking',
    question: 'What do the “check” marks mean?',
    paragraphs: [
      'The values in a document are read by an AI model, which says how sure it is of each one. When it is not sure, the value is marked “check”.',
      'Open the document, compare the value with the page beside it and correct it if it is wrong. What you correct stays corrected, even if the document is read again. Mark the document reviewed when you are done; the Review page lists the ones still waiting.',
    ],
  },
  {
    id: 'sharing',
    question: 'How do I share with a doctor?',
    paragraphs: [
      'On the Share links page, make a link to all your records, to a tag, to a period, to an episode of care or to the documents you pick. Send the link to the doctor; they open it in a browser, with no account.',
      'A link ends by itself (after 7 days unless you choose otherwise), and you can end it at any time. You choose whether it shows the scanned pages, whether the doctor may ask questions about what you shared, and whether each new browser must wait for your approval.',
      'The key that opens a link is in the address itself, after the # sign, which a browser never sends to the server. So only someone who has the whole link can read it.',
    ],
  },
  {
    id: 'privacy',
    question: 'How is my data kept private?',
    paragraphs: [
      'Your records are locked on this device with a key made from your master password. The server keeps them only in that locked form and cannot open them.',
      'Some things need an AI model: reading a document, translating it, finding the documents connected to it, and answering questions here. For those, the text goes to the AI model this server uses (and, when this server reads scans with AI, the picture of a scanned page), through a relay that does not store or log it.',
      'You can export everything, or delete your account and all your records, from the Account page.',
    ],
  },
  {
    id: 'password',
    question: 'Why does it ask for my master password again?',
    paragraphs: [
      'The key that opens your records is made from your master password and is kept only while the page is open. It is never saved, not even on this device, so after a reload or a restart the records are locked again.',
      'Staying signed in and opening the records are two different things: you may still be signed in and only be asked to open them. A passkey (Face ID, a fingerprint, a security key) set up on the Account page can open them instead of the password.',
      'If you forget the master password, your recovery kit is the only way back in: nobody else can open your records for you.',
    ],
  },
  {
    id: 'assistant',
    question: 'What can the assistant do?',
    paragraphs: [
      'It answers questions from your own documents, with links to where each answer came from: when a test was done, how a value changed, what a letter says.',
      'It can also prepare changes for you, such as a share link, a note, a correction, tags or a better grouping. Each one is shown as a card and nothing happens until you confirm it.',
      'It does not say what a result means for your health: that is a question for your doctor. Its answers are written by an AI model and can be wrong, so check what matters against the original.',
    ],
  },
  {
    id: 'results',
    question: 'Where do my test results go?',
    paragraphs: [
      'When a lab report or a note with vitals is read, each result is kept with its value, its unit and the reference range printed beside it. The document page lists them under Measurements.',
      'The Trends page draws each test over time, from every document that has it. Labs often name the same test differently: open the test on the Trends page and choose the name it should be counted with, and its values move there.',
      'A value marked “check” is one the AI was not sure of. Correct it on the document page and the trend follows.',
    ],
  },
  {
    id: 'doctors',
    question: 'How does Spine keep track of my doctors?',
    paragraphs: [
      'The doctors a document names are read with it and kept on the Doctors page, each with the documents that name them.',
      'The same doctor is often written differently from one document to the next. A name Spine already knows is filed under the same doctor, but when a new name might be someone already there, Spine asks you instead of guessing: in the report of the upload and on the Doctors page. Merging keeps every document under one name.',
      'You can correct a doctor’s name, specialty or clinic on their own page, and merge another entry into it there.',
    ],
  },
  {
    id: 'connections',
    question: 'What are connected documents?',
    paragraphs: [
      'Some documents belong together: a consultation and the tests it asked for, or a visit and the follow-up after it. A document’s page lists the ones connected to it.',
      'After an upload is read, Spine looks for them: it picks candidates from what the documents share (tests, doctors, tags, the clinic, how close the dates are) and asks the AI which are really connected. What it finds is only a suggestion, “possibly connected”, with what the documents share beneath it. Confirm it, or choose “Not related” and it is not suggested again.',
      'You can also add a connection yourself. A doctor you share both documents with sees the connections you confirmed.',
    ],
  },
  {
    id: 'episodes',
    question: 'What is an episode?',
    paragraphs: [
      'An episode groups the documents of one stretch of care, such as a visit, the tests before it and the letter after it, so you can see them together and share them with one link.',
      'Spine suggests episodes from the documents alone: ones connected to each other, or from the same clinic within two weeks. A suggestion is named by its clinic and dates, and says nothing about your health. Nothing counts until you confirm it on the Episodes page, and you can make one yourself.',
    ],
  },
  {
    id: 'library',
    question: 'What is the Library for?',
    paragraphs: [
      'Documents are read one at a time, so the same thing can arrive spelled several ways. The Library lists the tags, clinics and test names in use.',
      'Rename one to tidy it; give it a name that already exists and the two become one. Removing a tag or clearing a clinic leaves the documents as they are. When a document is read, Spine prefers the tags and test names already in your Library.',
      'A share link made for a tag follows it when it is renamed, and shares nothing once the tag is removed.',
    ],
  },
];

/** The topics the chat's welcome offers: the first steps. The rest are for a tip's "Tell me more" and for the assistant. */
export const START_TOPICS = ['adding', 'grouping', 'checking', 'sharing', 'privacy', 'password', 'assistant'];

export const helpTopic =(id: string): HelpTopic | undefined => HELP_TOPICS.find(t => t.id === id);

/** A topic as one text, for the assistant and for the stored message the model reads back. */
export const helpText = (topic: HelpTopic): string => `${topic.question}\n\n${topic.paragraphs.join('\n\n')}`;
