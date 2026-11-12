import { cases } from './cases.js';

// Informal wording: misspellings, transposed letters, missing capitals/punctuation, text-speak.
// Written BEFORE the typo-tolerance work it measures, and never used to tune it. Synthetic.
const questions = {
  display: [
    'my laptop screeen keeps flickring when i turn it on',
    'disply flikers every time at startp pls help',
    'the monitr is flashng after bootng up the notebok',
  ],
  wireless: [
    'wifi keeps droping and i have to reconect every few mins',
    'my wireles conection is unstabel, it disconects all the time',
    'internt keeps cuting out on my laptop',
  ],
  battery: [
    'batery drains reaaally fast even when i am not using the laptop',
    'my battry percentge falls quikly when idle',
    'laptop chargr runs out super fast',
  ],
  printer: [
    'printr says paper jamm but nothing is stuk inside',
    'the printe is jamed and wont print anymore',
    'papr keeps getin stuck in my printer',
  ],
  vpn: [
    'vpn wont let me sign in, says my pasword is rejectd',
    'cant authentcate on the vpn it keeps denyng my login',
    'vpn login faling every time i try',
  ],
  audio: [
    'no sond coming from my speakrs at all',
    'audo is compeltely silnt on my computer',
    'cant here anything from the laptop speakers',
  ],
  camera: [
    'webcm just shows a blak screen in calls',
    'my camra preview is blnk, no picture',
    'the webcamm is emtpy when i open it',
  ],
  storage: [
    'disk is ful and i cant save files anymore',
    'storge is used up, no free spce left',
    'my drve is out of room cant save anything',
  ],
  email: [
    'emial is not syncing, inbx never updates',
    'my mailbx stoped refreshng with new mesages',
    'mail aplication wont sych new emails',
  ],
  application: [
    'the aplication crashs right after i open it',
    'my progam quts as soon as it starts',
    'sofware closes by itslf immediatly after launching',
  ],
};
export const informalCases = cases.map((c) => ({ ...c, queries: questions[c.id] }));
