// File: api/getScribdLink.js (Vercel - Faster Version)

const fetch = require('node-fetch'); // Already a dependency

// --- Helper Functions (Unchanged) ---
function extractScribdInfo(url) {
     if (!url || typeof url !== 'string') { throw new Error('Invalid URL provided for extraction.'); }
     // Using a slightly more robust regex to capture different URL structures better initially
     const regex = /(?:[a-z]{2,3}\.)?scribd\.com\/(?:document|doc|presentation|book|audiobook|embeds)\/(\d+)(?:\/([^?\/]+))?/;
     const match = url.match(regex);
     if (match && match[1]) {
         const docId = match[1];
         // Generate a simple slug if none is found in the URL
         const titleSlug = match[2] ? match[2].replace(/\/$/, '') : `document-${docId}`;
         const title = titleSlug.replace(/-/g, ' ');
         console.log(`[Vercel Fn] Extracted: ID=${docId}, Slug=${titleSlug}`);
         return { docId, title, titleSlug };
     } else {
         console.error(`[Vercel Fn] Failed to match Scribd URL format: ${url}`);
         throw new Error('Invalid or unrecognized Scribd URL format.');
     }
}

function generateIlideLink(docId, titleSlug) {
    // Keep original generation logic, ensure proper encoding
    const fileUrl = encodeURIComponent(`https://scribd.vdownloaders.com/pdownload/${docId}%2F${titleSlug}`);
    const titleWithSpaces = titleSlug.replace(/-/g, ' ');
    // Simpler title encoding might be sufficient, test if original encoding is truly needed
    // const encodedTitle = encodeURIComponent(`<div><p>${titleWithSpaces}</p></div>`); // Original
    const encodedTitle = encodeURIComponent(titleWithSpaces); // Simpler title
    return `https://ilide.info/docgeneratev2?fileurl=${fileUrl}&title=${encodedTitle}&utm_source=scrfree&utm_medium=queue&utm_campaign=dl`;
}

// Regular expression to find the viewer URL in the HTML content
// Look for something like: ... src='/viewer/web/viewer.html?file=SOME_ENCODED_URL' ...
// Make it flexible for single or double quotes and potential variations
const viewerUrlRegex = /['"](\/viewer\/web\/viewer\.html\?file=([^'"]+))['"]/;

// --- Vercel Serverless Function Handler (Faster Version) ---
module.exports = async (req, res) => {
    if (req.method !== 'POST') {
        res.setHeader('Allow', ['POST']);
        return res.status(405).json({ error: `Method ${req.method} Not Allowed` });
    }

    const { scribdUrl } = req.body;
    if (!scribdUrl || typeof scribdUrl !== 'string') {
        console.error("[Vercel Fn] Invalid request body:", req.body);
        return res.status(400).json({ error: 'Missing or invalid scribdUrl in request body.' });
    }

    console.log(`[Vercel Fn] Request for: ${scribdUrl} (Using fetch)`);

    try {
        const { docId, titleSlug } = extractScribdInfo(scribdUrl);
        const ilideLink = generateIlideLink(docId, titleSlug);
        console.log(`[Vercel Fn] Target ilide.info link: ${ilideLink}`);

        // --- Make Direct HTTP Request ---
        console.log(`[Vercel Fn] Fetching ${ilideLink}...`);
        const response = await fetch(ilideLink, {
            method: 'GET',
            headers: {
                // Mimic a browser user-agent if necessary, but often not required
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                // Add Referer? Sometimes helpful, points back to where the request originated (conceptually)
                 // 'Referer': 'https://google.com' // Or perhaps the original scribd URL? Test if needed.
            },
            // Set a reasonable timeout for the fetch request itself
            timeout: 25000, // 25 seconds timeout for fetch
        });

        if (!response.ok) {
            console.error(`[Vercel Fn] Failed to fetch ilide link. Status: ${response.status} ${response.statusText}`);
            // Attempt to read body for more info if available
            let errorBody = 'No error body available.';
            try { errorBody = await response.text(); } catch (e) {/* ignore */}
            console.error(`[Vercel Fn] Error body: ${errorBody.substring(0, 500)}`); // Log first 500 chars
            throw new Error(`Failed to fetch from ilide.info. Status: ${response.status}`);
        }

        const htmlContent = await response.text();
        console.log('[Vercel Fn] Successfully fetched ilide.info page content.');
         // Optional: Log a snippet for debugging if needed
         // console.log('[Vercel Fn] HTML Snippet:', htmlContent.substring(0, 500));

        // --- Extract the Link from HTML ---
        const match = htmlContent.match(viewerUrlRegex);

        if (match && match[2]) {
            let encodedFileParam = match[2];
            // The original code sometimes double-decoded. Replicate that logic.
            let decodedLink = decodeURIComponent(encodedFileParam);
            try {
                 // Attempt a second decode, might fail if already fully decoded
                let doubleDecoded = decodeURIComponent(decodedLink);
                // Simple check if second decode looks like a valid URL
                if (doubleDecoded.startsWith('http://') || doubleDecoded.startsWith('https://')) {
                     decodedLink = doubleDecoded;
                }
            } catch (e) {
                // Ignore error, means it was likely only single-encoded
                console.log('[Vercel Fn] Double decoding failed or not needed, using single decode result.');
            }

             // Basic validation: does it look like a plausible download URL?
             if (!decodedLink || !(decodedLink.startsWith('http://') || decodedLink.startsWith('https://')) || decodedLink.length < 20) {
                console.error('[Vercel Fn] Extracted link seems invalid:', decodedLink);
                throw new Error('Failed to extract a valid download link from ilide.info response.');
            }

            console.log('[Vercel Fn] Successfully extracted download link:', decodedLink);
            return res.status(200).json({ downloadLink: decodedLink });

        } else {
            console.error('[Vercel Fn] Could not find viewer URL pattern in ilide.info HTML.');
             // Log more HTML if debugging is needed
             // console.error('[Vercel Fn] Full HTML content length:', htmlContent.length);
            throw new Error('Download link pattern not found on ilide.info.');
        }

    } catch (error) {
        // Handle Errors
        console.error("[Vercel Fn] Error during processing:", error);
        const statusCode = error.message.includes("Scribd URL format") ? 400
                         : error.message.includes("fetch") || error.message.includes("ilide.info") ? 502 // Bad Gateway if upstream fails
                         : 500; // Internal Server Error for others
        // Sanitize error message for client
        let clientErrorMessage = 'An internal server error occurred.';
        if (statusCode === 400 || statusCode === 502) {
            clientErrorMessage = error.message;
        }
         // Avoid leaking internal details like specific regex failures in user-facing errors
         if (error.message.includes("pattern not found")) {
             clientErrorMessage = "Could not retrieve download link from the processing service.";
         } else if (error.message.includes("valid download link")) {
             clientErrorMessage = "Processing service returned an invalid link.";
         }

        return res.status(statusCode).json({ error: clientErrorMessage });
    }
    // No finally block needed as there's no browser to close
};
