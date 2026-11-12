import { cases } from './cases.js';

// Validation set written AFTER the retrieval-strengthening work, then measured once and
// never tuned against. It uses new vocabulary, longer sentences and mixed registers.
// Synthetic: it shows behaviour on this wording, not on real customer messages.
const questions = {
  display: [
    'Ever since the update my laptop panel shakes and twitches for the first minute after it turns on.',
    'The picture on my notebook is unstable when the machine starts up, it keeps wavering.',
    'On boot the display has a rapid on-off shimmer that goes away later.',
  ],
  wireless: [
    'My laptop repeatedly loses the office wifi signal and I have to join it again.',
    'The wireless connection is unreliable: it works, then drops, then comes back.',
    'Every so often the internet link breaks while I am on a video call.',
  ],
  battery: [
    'Even in sleep mode the laptop empties its battery overnight.',
    'The charge level collapses quickly when I am not using the computer.',
    'My notebook battery does not last, it depletes much too fast when idle.',
  ],
  printer: [
    'The printer shows a paper jam error but I cannot find any stuck page.',
    'A sheet of paper is jammed in the printer and printing cannot proceed.',
    'Each print job fails because the paper gets stuck in the rollers.',
  ],
  vpn: [
    'The VPN refuses my password every time I attempt to sign in.',
    'I try to authenticate to the company VPN but the login is denied.',
    'Signing in to the VPN fails with an authentication rejection message.',
  ],
  audio: [
    'There is no audio output from my laptop speakers at all.',
    'The computer is completely silent when I play any sound.',
    'I cannot hear anything from the built-in speakers during meetings.',
  ],
  camera: [
    'My webcam shows a black empty window in video calls.',
    'The laptop camera preview is blank, there is no image.',
    'When I switch on the camera the picture area stays dark and empty.',
  ],
  storage: [
    'My disk has run out of free room and I cannot save new files.',
    'The storage on this computer is full and nothing more can be written.',
    'I get a message that there is no space left on the drive.',
  ],
  email: [
    'My inbox is not refreshing, new emails never show up.',
    'Mail synchronization has stopped working on my laptop.',
    'The email app is stuck and the mailbox is not updating with recent messages.',
  ],
  application: [
    'The app crashes immediately every time I open it.',
    'As soon as I launch the program it quits on its own.',
    'The software closes unexpectedly right after starting.',
  ],
};
export const validationCases = cases.map((c) => ({ ...c, queries: questions[c.id] }));

// Near-miss questions: they share words/concepts with a stored fix but describe a DIFFERENT need.
// None of them may receive any suggestion. (Used by test/rag-quality.test.js.)
export const hardNegatives = [
  'I forgot my wifi password and need to look it up.',
  'How do I buy a replacement battery for my laptop?',
  'The printer is out of toner and the prints look faint.',
  'My screen is too dim, how do I raise the brightness?',
  'How do I set up an email signature in my mail app?',
  'Where can I download the VPN client installer?',
  'Can you recommend a good external speaker for music?',
  'How do I change the background of my webcam during calls?',
  'I want to buy more storage space for my laptop.',
  'How do I uninstall an application I no longer use?',
  'What is the warranty period for my laptop battery?',
  'How do I print double-sided pages?',
];
