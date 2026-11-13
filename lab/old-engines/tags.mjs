// Image tag (without its name suffix) -> the Chrome major it holds, for check.mjs and check-deep.mjs. run.sh pins each tag by
// digest; a digest copied to the wrong tag, or a tag left out of the list, would quietly drop an engine from "Chrome 53 to 80".
export const TAGS = { '2.53.0': 53, '3.4.0': 59, '3.8.1': 63, '3.14.0': 68, '3.141.59': 80 }
