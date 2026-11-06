import { cases } from './cases.js';

// Authored before this challenge's first run. Not added to resolution symptoms,
// examples, prompts or normalization rules. Synthetic, not independent user data.
const questions = {
  display: [
    'Every time the computer starts, the picture rapidly alternates between bright and dark.',
    'During boot the built-in panel keeps flashing, although the machine finishes starting.',
    'Startup completes but the image on the notebook is blinking. Is there an approved remedy?',
  ],
  wireless: [
    'I keep getting kicked off the wireless network and have to reconnect.',
    'The Wi-Fi works briefly, loses its connection, then does it all over again.',
    'My internet connection repeatedly drops while I am working over Wi-Fi.',
  ],
  battery: [
    'A full charge disappears far too soon, even when the computer is doing very little.',
    'The battery percentage falls unusually fast while the notebook sits idle.',
    'I unplug the laptop and it runs out of battery much sooner than it should.',
  ],
  printer: [
    'A sheet is trapped in the printer and the job cannot continue.',
    'The printer stopped feeding paper and says a page is jammed inside.',
    'Printing has stopped because paper is wedged in the feed path.',
  ],
  vpn: [
    'I reach the VPN sign-in screen but it will not accept my authentication.',
    'The corporate VPN turns down my login attempt instead of connecting.',
    'VPN authentication fails every time I try to sign in.',
  ],
  audio: [
    'A video is playing but nothing can be heard from the built-in speakers.',
    'There is no sound coming out of the laptop audio output.',
    'The speakers stay completely quiet when I play audio.',
  ],
  camera: [
    'My meeting camera preview is just an empty black rectangle.',
    'The webcam is selected but its preview contains no picture, only black.',
    'Instead of showing me, the camera preview stays blank.',
  ],
  storage: [
    'I cannot save anything because the drive has no room left.',
    'The computer reports that its storage capacity is completely used up.',
    'The disk is full and there is no free space for another file.',
  ],
  email: [
    'My mailbox has stopped updating with new messages.',
    'Email synchronization has stalled and the message list never refreshes.',
    'New mail is not being synchronized into my inbox.',
  ],
  application: [
    'The program quits unexpectedly as soon as I launch it.',
    'Opening the application immediately makes it crash.',
    'I launch the app, then its window unexpectedly closes before I can use it.',
  ],
};

export const challengeCases = cases.map((c) => ({ ...c, queries: questions[c.id] }));
