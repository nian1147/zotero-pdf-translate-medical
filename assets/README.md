# Avatar artwork

`avatar.png` is the square master for the medical edition's chick avatar. It was
derived from the user's supplied avatar screenshot using the built-in imagegen
tool on 2026-10-13. The output preserves the reference character and omits the
surrounding screenshot text, bars and controls. It is an AI-derived image, not a
pixel-identical crop of the source.

Final generation prompt:

> Use case: identity-preserve. Asset type: square avatar PNG icon for a Zotero
> translation plugin. Edit target: the attached screenshot. Extract the central
> SQUARE illustrated avatar panel only (approximately x=0..1080, y=488..1555 in the
> original 1080x2108 screenshot), excluding ALL surrounding black screenshot bars,
> captions, UI and text. Preserve the original cartoon chick image exactly in
> identity, pose, expression, proportions, colors, bold black outlines, grey
> center-parted hairstyle, large eyes, yellow face, red cheeks, black clothing,
> basketball on the left, and pastel cyan/pink background. This is a faithful
> square avatar extraction, not a new illustration or redesign. No additional
> text, no added decorations, no border. Output one square image filling the
> canvas, clear enough to resize to small toolbar icons.

The runtime uses PNG variants at 16, 20, 48 and 96 pixels in
`addon/chrome/content/icons/`. Only these small icons are packaged; this master
stays in the source tree. SVG wrappers preserve the previous section icon paths.
The existing license and copyright terms of the supplied illustration still
apply.

To regenerate sizes, install `sharp` in your tooling environment and run:

```sh
node scripts/build-avatar-icons.cjs
```

The script does not call imagegen or any network service.
