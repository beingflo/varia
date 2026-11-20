import { render } from 'solid-js/web';
import Landing from './Landing';
import { hasEntered } from './lib/entry';
import './style.css';

const path = location.pathname;
// `/landing` always wins; a first visit to `/` is the landing, and says so in the url. Everything
// else — `/app` from an installed window, a `/note/<id>` deep link — is the app.
const landing = path === '/landing' || (path === '/' && !hasEntered());

if (landing) {
  if (path === '/') history.replaceState(null, '', '/landing');
  render(() => <Landing />, document.getElementById('root')!);
} else {
  void import('./boot').then((m) => m.startApp());
}
