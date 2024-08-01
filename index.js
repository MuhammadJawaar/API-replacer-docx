const express = require('express');
const multer = require('multer');
const PizZip = require('pizzip');
const Docxtemplater = require('docxtemplater');
const admin = require('firebase-admin');
const { v4: uuidv4 } = require('uuid');

const serviceAccount = require('./serviceAccountKey.json');

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    storageBucket: 'suratproject-38713.appspot.com',
});

const storage = admin.storage().bucket();
const db = admin.firestore();

const app = express();
const port = 3001;

const multerStorage = multer.memoryStorage();
const upload = multer({ storage: multerStorage });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Function to extract tags from DOCX file
function extractTags(content) {
    const zip = new PizZip(content);
    const doc = new Docxtemplater(zip, {
        paragraphLoop: true,
        linebreaks: true,
    });

    const tags = doc.getFullText().match(/t\.\w+/g);
    return tags ? Array.from(new Set(tags)) : [];
}
app.get("/", (req, res) => {
    res.send("Express on Vercel");
  });
// Endpoint to upload template to Firebase Storage and Firestore
app.post('/upload-template', upload.single('template'), async (req, res) => {
    if (!req.file) {
        return res.status(400).send('No file uploaded');
    }

    const fileName = req.file.originalname;
    const file = storage.file(fileName);
    const [exists] = await file.exists();

    if (exists) {
        return res.status(400).send('File with the same name already exists');
    }

    const blobStream = file.createWriteStream({
        resumable: false,
        contentType: req.file.mimetype,
    });

    blobStream.on('error', (err) => {
        res.status(500).send('Error uploading file');
    });

    blobStream.on('finish', async () => {
        try {
            const [content] = await file.download();
            const tags = extractTags(content);
            const uniqueId = uuidv4();
            const timestamp = admin.firestore.FieldValue.serverTimestamp();
            await db.collection('templates').doc(uniqueId).set({
                id: uniqueId,
                name: fileName,
                url: `gs://suratproject-38713.appspot.com/${fileName}`,
                createdAt: timestamp,
                tags: tags,
            });
            res.send('File uploaded and saved to Firebase Storage and Firestore successfully');
        } catch (error) {
            res.status(500).send('Error saving template information to Firestore');
        }
    });

    blobStream.end(req.file.buffer);
});

// Endpoint to generate DOCX file and send as download without saving to storage
app.post('/generate-docx', upload.none(), async (req, res) => {
    const { templateId, ...replacements } = req.body;

    if (!templateId) {
        return res.status(400).send('Template ID is required');
    }

    try {
        const templateDoc = await db.collection('templates').doc(templateId).get();
        if (!templateDoc.exists) {
            return res.status(404).send('Template not found');
        }

        const templateData = templateDoc.data();
        const templateName = templateData.name;
        const file = storage.file(templateName);
        const [content] = await file.download();

        const zip = new PizZip(content);
        const doc = new Docxtemplater(zip, {
            paragraphLoop: true,
            linebreaks: true,
        });

        const filteredReplacements = {};
        for (const key in replacements) {
            if (key.startsWith('t.')) {
                filteredReplacements[key] = replacements[key];
            }
        }

        doc.setData(filteredReplacements);

        try {
            doc.render();
        } catch (error) {
            return res.status(500).send('Error rendering document');
        }

        const buf = doc.getZip().generate({ type: 'nodebuffer' });

        // Set headers to send the file as a download
        res.setHeader('Content-Disposition', 'attachment; filename=output.docx');
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
        res.send(buf);
    } catch (error) {
        res.status(500).send('Error processing template file');
    }
});

// Endpoint to get list of templates from Firestore
app.get('/templates', async (req, res) => {
    try {
        const snapshot = await db.collection('templates').get();
        const templates = snapshot.docs.map(doc => doc.data());
        res.json(templates);
    } catch (error) {
        res.status(500).send('Error getting templates from Firestore');
    }
});

app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});

module.exports = app;
