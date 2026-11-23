import { isSelfDestination } from './model.mts';

const link = document.querySelector<HTMLAnchorElement>('[data-redirect]');
const pageUrl =
  document.querySelector<HTMLMetaElement>('meta[property="og:url"]')?.content || location.href;
if (link && !isSelfDestination(link.href, pageUrl)) location.replace(link.href);
