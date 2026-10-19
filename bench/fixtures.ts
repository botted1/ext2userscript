// Pages the cases serve in place of sites that stop automated browsers.

// A Google results page for the search cases, in the markup both extensions look for: each result is a .vt6azd
// block in #search with a link around its h3, under an .r.yuRUbf wrapper.
const result = (url: string, title: string) =>
  `<div class="MjjYud"><div class="g vt6azd" data-hveid="x"><div class="r yuRUbf"><a href="${url}"><h3>${title}</h3><cite>${new URL(url).hostname}</cite></a></div><div class="VwiC3b">About ${title}.</div></div></div>`;

export const GOOGLE_RESULTS = `<!doctype html><html lang="en"><title>userscript - Google Search</title>
<body><div id="main"><div id="search"><div id="rso">
${result("https://en.wikipedia.org/wiki/Userscript", "Userscript - Wikipedia")}
${result("https://www.tampermonkey.net/", "Tampermonkey")}
${result("https://violentmonkey.github.io/", "Violentmonkey")}
</div></div></div></body></html>`;

// An old Reddit subreddit listing for Reddit Enhancement Suite: the header and one link post with an image.
export const OLD_REDDIT = `<!doctype html><html lang="en"><title>userscripts</title>
<body class="listing-page"><div id="header"><div id="header-bottom-left"><span class="pagename redditname"><a href="/r/userscripts/">userscripts</a></span></div>
<div id="header-bottom-right"><span class="user">Want to join? <a href="/login">Log in or sign up</a></span></div></div>
<div class="content" role="main"><div id="siteTable" class="sitetable linklisting">
<div class="thing link" id="thing_t3_x2u" data-fullname="t3_x2u" data-type="link" data-subreddit="userscripts" data-author="x2u" data-domain="i.redd.it" data-url="https://i.redd.it/x2u.png">
<div class="entry"><div class="top-matter"><p class="title"><a class="title may-blank" href="https://i.redd.it/x2u.png">A screenshot</a></p>
<ul class="flat-list buttons"><li class="first"><a class="bylink comments" href="https://old.reddit.com/r/userscripts/comments/x2u/a_screenshot/">2 comments</a></li></ul></div></div></div>
</div></div></body></html>`;
