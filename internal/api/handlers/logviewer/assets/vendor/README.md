# Vendored Markdown dependencies

These browser distributions are embedded and served locally. There are no runtime
CDN requests or frontend installation/build steps.

| Dependency | Version | Source | License |
| --- | --- | --- | --- |
| Marked | 18.0.11 | https://registry.npmjs.org/marked/-/marked-18.0.11.tgz (`package/lib/marked.umd.js`) | MIT; see `marked.LICENSE` |
| DOMPurify | 3.4.14 | https://registry.npmjs.org/dompurify/-/dompurify-3.4.14.tgz (`package/dist/purify.min.js`) | Apache-2.0 OR MPL-2.0; see `DOMPurify.LICENSE` and `DOMPurify.LICENSE-MPL` |

The package tarballs were SHA-512 verified against the npm registry metadata:

- Marked: `HnslJfsZkRPBDJRHvVtAaWlZHEpSu7u8LgQuJCELjRKuWR+hpq4A7sLq3p8HaI9ypVoXDXxV34CsQJEe1+J5Aw==`
- DOMPurify: `dVoH9z+MY+C9IilgGCk3YfFqjLi3fChm2OiKJMzh6axrJ5qwxqWaZamgmHrpv22CN/KdbZJuGEGgfQoL00LTdg==`

Retain copyright banners and licenses when updating. Run the viewer's Markdown
security tests after an update. Upstream source maps are not included.
