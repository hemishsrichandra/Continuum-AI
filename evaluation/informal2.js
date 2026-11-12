import { cases } from './cases.js';

// Second informal set, written after the typo-tolerance work and measured once without tuning.
// Different misspellings and slang from informal.js. Synthetic.
const questions = {
  display: [
    'the screan on my notbook shimers and jumps when it boots',
    'laptop moniter flikering as soon as windows starts',
    'picutre keeps pulsing on the pannel whenever i power on',
  ],
  wireless: [
    'my wifi conneciton keeps dropping out all day long',
    'wirelss link is unrelible and keeps disconecting from the router',
    'no internet bcos the network keeps cutting out again',
  ],
  battery: [
    'laptop battry dies so quik even when closed',
    'the batery level plumets overnight with nothing running',
    'chrage goes down way too fast when im not using it',
  ],
  printer: [
    'printer sais theres a paper jamm but i cant see any',
    'paper is wedgd in the printer rollers again',
    'my printr keeps jaming on every page',
  ],
  vpn: [
    'cannot login to the vpn it just rejcts my password',
    'vpn authentification fails everytime i sign in',
    'company vpn keeps refusng my credentails',
  ],
  audio: [
    'there is no sund at all from the laptop speakrs',
    'the compter audio is dead silnt',
    'speakers are totaly quiet when i play musci',
  ],
  camera: [
    'webcamm shows nothing but a blck box on video calls',
    'my laptop camra is blank and shows no pictre',
    'the camrea preview window is empy',
  ],
  storage: [
    'harddrive is compeltely full cant store any more files',
    'disk spase is all used up so saving fails',
    'no free storge on my pc anymore',
  ],
  email: [
    'new emals never show up my inbxo is frozen',
    'mail syncronization stoped working on my laptop',
    'mailbox isnt refreshin with recent mesages',
  ],
  application: [
    'app crashs on startup every single time',
    'the sofware just quits by itsself after opening',
    'my application closes unexpectdly right after it launches',
  ],
};
export const informal2Cases = cases.map((c) => ({ ...c, queries: questions[c.id] }));
